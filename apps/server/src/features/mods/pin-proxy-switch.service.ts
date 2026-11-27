import type { PinProxySwitchState } from '../../infrastructure/db/schema.js'
import type { PinProxySwitchRow } from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
import type { MoveProxyPinResult } from '../../infrastructure/gateways/mods.gateway.js'
import { PIN_PROXY_GIVE_UP_MS, PIN_PROXY_RETRY_MS } from './pin-proxy.js'

// One round of the pin proxy's timer. A switch is due 10 minutes after its pin
// and then every 2 minutes (the claim moves its next check by the retry
// interval, see claimDuePinProxySwitches). For each due switch:
//  - the pin is no longer that version at the proxy URL (an admin re-pinned
//    or un-ranked the mod): done, 'superseded', nothing is written to the pin;
//  - 7 days have passed: 'gave_up', the proxy pin stays;
//  - Thunderstore does not have the version up yet: nothing, ask again later;
//  - it is up: refresh the Thunderstore versions, then move the pin to the
//    Thunderstore version (only while it is still the proxy pin).
// A switch that ends 'switched' or 'superseded' drops its stored zip; one that
// gives up keeps it, because the pin still points at the proxy.

export interface PinProxySwitchDeps {
	claimDue(now: Date, leaseMs: number): Promise<PinProxySwitchRow[]>
	findMod(modId: string): Promise<{
		id: string
		thunderstoreFullName: string | null
		rankedVersion: string | null
		rankedDownloadUrl: string | null
	} | null>
	thunderstoreStatus(
		fullName: string,
		version: string,
	): Promise<'up' | 'not-up'>
	refreshVersions(): Promise<void>
	moveToThunderstore(
		modId: string,
		version: string,
		proxyUrl: string,
	): Promise<MoveProxyPinResult>
	note(id: number, note: string): Promise<void>
	finish(
		id: number,
		state: Exclude<PinProxySwitchState, 'pending'>,
		note: string,
		now: Date,
	): Promise<void>
	// Drops the stored zip: the pin no longer uses the proxy URL.
	clearZip(id: number): Promise<void>
	reloadConfig(): Promise<void>
	logSwitch(entry: {
		modId: string
		version: string
		hash: string
		proxyHash: string
		hashChanged: boolean
	}): Promise<void>
	now(): Date
}

export type SwitchOutcome = 'waiting' | 'switched' | 'superseded' | 'gave_up'

export async function runPinProxySwitches(
	deps: PinProxySwitchDeps,
): Promise<SwitchOutcome[]> {
	const due = await deps.claimDue(deps.now(), PIN_PROXY_RETRY_MS)
	const outcomes: SwitchOutcome[] = []
	for (const row of due) {
		try {
			outcomes.push(await runOne(row, deps))
		} catch (err) {
			// The claim already moved its next check, so this retries in 2 minutes.
			console.error(
				`[pin-proxy] Check failed for ${row.modId}@${row.version}:`,
				err,
			)
			outcomes.push('waiting')
		}
	}
	return outcomes
}

async function runOne(
	row: PinProxySwitchRow,
	deps: PinProxySwitchDeps,
): Promise<SwitchOutcome> {
	const now = deps.now()
	const mod = await deps.findMod(row.modId)
	if (
		!mod ||
		mod.rankedVersion !== row.version ||
		mod.rankedDownloadUrl !== row.proxyUrl
	) {
		await deps.finish(
			row.id,
			'superseded',
			'The pin was changed by an admin, so the proxy pin was left alone.',
			now,
		)
		await deps.clearZip(row.id)
		return 'superseded'
	}
	if (now.getTime() - row.startedAt.getTime() >= PIN_PROXY_GIVE_UP_MS) {
		await deps.finish(
			row.id,
			'gave_up',
			'Thunderstore did not list the version in time. The proxy pin stays.',
			now,
		)
		console.warn(
			`[pin-proxy] Gave up on ${row.modId}@${row.version}: not on Thunderstore after ${row.attempts} checks. The proxy pin stays.`,
		)
		return 'gave_up'
	}
	if (!mod.thunderstoreFullName) {
		await deps.note(row.id, 'The mod has no Thunderstore package name.')
		return 'waiting'
	}

	const status = await deps.thunderstoreStatus(
		mod.thunderstoreFullName,
		row.version,
	)
	if (status === 'not-up') {
		await deps.note(row.id, 'Thunderstore does not have the version up yet.')
		return 'waiting'
	}

	await deps.refreshVersions()
	const moved = await deps.moveToThunderstore(
		row.modId,
		row.version,
		row.proxyUrl,
	)
	if (!moved.ok) {
		if (moved.reason === 'pin-changed') {
			await deps.finish(
				row.id,
				'superseded',
				'The pin was changed by an admin, so the proxy pin was left alone.',
				now,
			)
			await deps.clearZip(row.id)
			return 'superseded'
		}
		await deps.note(
			row.id,
			moved.reason === 'not-listed'
				? 'Thunderstore has the version, but the Server list does not yet.'
				: 'Thunderstore has the version, but the Server could not hash it yet.',
		)
		return 'waiting'
	}

	const hashChanged = moved.hash !== row.proxyHash
	await deps.finish(
		row.id,
		'switched',
		hashChanged
			? 'Switched to Thunderstore. The hash is different from the proxy hash.'
			: 'Switched to Thunderstore. The hash is the same.',
		now,
	)
	await deps.clearZip(row.id)
	await deps.reloadConfig()
	if (hashChanged)
		console.warn(
			`[pin-proxy] ${row.modId}@${row.version}: the Thunderstore hash ${moved.hash} differs from the proxy hash ${row.proxyHash}. Players who have the proxy copy will download it again.`,
		)
	else
		console.log(
			`[pin-proxy] ${row.modId}@${row.version}: switched to Thunderstore, same hash`,
		)
	await deps.logSwitch({
		modId: row.modId,
		version: row.version,
		hash: moved.hash,
		proxyHash: row.proxyHash,
		hashChanged,
	})
	return 'switched'
}
