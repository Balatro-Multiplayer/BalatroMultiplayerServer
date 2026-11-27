import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
	type PinProxySwitchState,
	modPinProxySwitches,
	modRegistryVersions,
} from '../db/schema.js'

export type PinProxySwitchRow = typeof modPinProxySwitches.$inferSelect

export interface NewPinProxySwitch {
	modId: string
	version: string
	assetUrl: string
	assetName: string
	proxyUrl: string
	proxyHash: string
	startedAt: Date
	nextCheckAt: Date
}

// Starts the switch for a mod's version, or starts it again if that version
// already has one (a repeat pin of the same release).
export async function upsertPinProxySwitch(
	input: NewPinProxySwitch,
): Promise<void> {
	const fresh = {
		assetUrl: input.assetUrl,
		assetName: input.assetName,
		proxyUrl: input.proxyUrl,
		proxyHash: input.proxyHash,
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

export async function findPinProxySwitch(
	modId: string,
	version: string,
): Promise<PinProxySwitchRow | null> {
	const rows = await db
		.select()
		.from(modPinProxySwitches)
		.where(
			and(
				eq(modPinProxySwitches.modId, modId),
				eq(modPinProxySwitches.version, version),
			),
		)
	return rows[0] ?? null
}

// The newest switch of a mod, for the admin page.
export async function latestPinProxySwitch(
	modId: string,
): Promise<PinProxySwitchRow | null> {
	const rows = await db
		.select()
		.from(modPinProxySwitches)
		.where(eq(modPinProxySwitches.modId, modId))
		.orderBy(desc(modPinProxySwitches.startedAt))
		.limit(1)
	return rows[0] ?? null
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
		.returning()
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
