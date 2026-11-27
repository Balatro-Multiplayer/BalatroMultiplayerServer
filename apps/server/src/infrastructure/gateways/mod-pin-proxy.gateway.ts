import { and, eq, getTableColumns, inArray, lte, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
	type PinProxySwitchState,
	modPinProxySwitches,
	modRegistryVersions,
} from '../db/schema.js'

// Every column but the zip, so listing and claiming switches never loads
// the bytes. The proxy route reads the zip alone (findPinProxyZip).
const { zipBytes: _zipBytes, ...switchColumns } =
	getTableColumns(modPinProxySwitches)

export type PinProxySwitchRow = Omit<
	typeof modPinProxySwitches.$inferSelect,
	'zipBytes'
>

export interface NewPinProxySwitch {
	modId: string
	version: string
	assetName: string
	proxyUrl: string
	proxyHash: string
	zipBytes: Buffer
	zipSha256: string
	startedAt: Date
	nextCheckAt: Date
}

// Starts the switch for a mod's version, or starts it again if that version
// already has one (a repeat pin of the same release).
export async function upsertPinProxySwitch(
	input: NewPinProxySwitch,
): Promise<void> {
	const fresh = {
		assetName: input.assetName,
		proxyUrl: input.proxyUrl,
		proxyHash: input.proxyHash,
		zipBytes: input.zipBytes,
		zipSha256: input.zipSha256,
		state: 'pending',
		startedAt: input.startedAt,
		nextCheckAt: input.nextCheckAt,
		lastCheckedAt: null,
		attempts: 0,
		finishedAt: null,
		note: null,
	}
	await db
		.insert(modPinProxySwitches)
		.values({ modId: input.modId, version: input.version, ...fresh })
		.onConflictDoUpdate({
			target: [modPinProxySwitches.modId, modPinProxySwitches.version],
			set: fresh,
		})
}

// The zip a switch row serves, or null when the row is gone or its bytes
// were cleared.
export async function findPinProxyZip(
	modId: string,
	version: string,
): Promise<{ assetName: string; zipBytes: Buffer; zipSha256: string } | null> {
	const rows = await db
		.select({
			assetName: modPinProxySwitches.assetName,
			zipBytes: modPinProxySwitches.zipBytes,
			zipSha256: modPinProxySwitches.zipSha256,
		})
		.from(modPinProxySwitches)
		.where(
			and(
				eq(modPinProxySwitches.modId, modId),
				eq(modPinProxySwitches.version, version),
			),
		)
	const row = rows[0]
	if (!row?.zipBytes || !row.zipSha256) return null
	return {
		assetName: row.assetName,
		zipBytes: row.zipBytes,
		zipSha256: row.zipSha256,
	}
}

// The switches that still concern a pin: waiting for Thunderstore, or given
// up (the proxy pin stays). For the admin ranked-mods list.
export async function listOpenPinProxySwitches(): Promise<PinProxySwitchRow[]> {
	return db
		.select(switchColumns)
		.from(modPinProxySwitches)
		.where(inArray(modPinProxySwitches.state, ['pending', 'gave_up']))
}

// Takes every pending switch that is due. Each one is leased: its next check
// moves forward by leaseMs in the same statement and its attempts go up, so a
// second Server process (or a slow run) does not take it again, and a crash
// leaves it due again after the lease.
export async function claimDuePinProxySwitches(
	now: Date,
	leaseMs: number,
): Promise<PinProxySwitchRow[]> {
	return db
		.update(modPinProxySwitches)
		.set({
			nextCheckAt: new Date(now.getTime() + leaseMs),
			lastCheckedAt: now,
			attempts: sql`${modPinProxySwitches.attempts} + 1`,
		})
		.where(
			and(
				eq(modPinProxySwitches.state, 'pending'),
				lte(modPinProxySwitches.nextCheckAt, now),
			),
		)
		.returning(switchColumns)
}

export async function notePinProxySwitch(
	id: number,
	note: string,
): Promise<void> {
	await db
		.update(modPinProxySwitches)
		.set({ note })
		.where(eq(modPinProxySwitches.id, id))
}

export async function finishPinProxySwitch(
	id: number,
	state: Exclude<PinProxySwitchState, 'pending'>,
	note: string,
	now: Date,
): Promise<void> {
	await db
		.update(modPinProxySwitches)
		.set({ state, note, finishedAt: now })
		.where(eq(modPinProxySwitches.id, id))
}

// Drops the stored zip once the pin no longer uses the proxy URL.
export async function clearPinProxyZip(id: number): Promise<void> {
	await db
		.update(modPinProxySwitches)
		.set({ zipBytes: null })
		.where(eq(modPinProxySwitches.id, id))
}

// True when the mod's version list has this version from Thunderstore.
export async function hasThunderstoreVersion(
	modId: string,
	version: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: modRegistryVersions.id })
		.from(modRegistryVersions)
		.where(
			and(
				eq(modRegistryVersions.modId, modId),
				eq(modRegistryVersions.version, version),
				eq(modRegistryVersions.source, 'thunderstore'),
			),
		)
	return rows.length > 0
}
