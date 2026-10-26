import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import type { NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import { retentionRepository } from '../../infrastructure/gateways/retention.gateway.js'
import type { Result } from '../../shared/utils/result.js'
import { type EvidenceLink, evidencePurgeable } from '../retention/limits.js'
import { NAMED_RUNS_PER_CALL } from '../retention/sweep.js'
import { RUN_LOG_TTL_MS } from './mirror.service.js'

// (The same hourly job also sweeps expired lobby checkpoints, login network
// hashes and the ban index entries of deleted accounts: see below.)
// Nakama keeps a finished run's record and replay logs for as long as
// match_run_logs keeps them here (RUN_LOG_TTL_MS): every hour, list the
// older ones (admin_runs_expired), keep each a report or ban still uses (the
// evidence rule, features/retention/limits.ts) and delete the rest
// (admin_runs_purge_named). Nakama does not list flagged and disputed runs,
// which the evidence sweep (features/retention/sweep.ts) names once past
// their limit. Hourly
// rather than daily so a sweep missed while Nakama is still booting (or
// restarting) is retried soon; a sweep with nothing to delete is one call.

export const RUN_RETENTION_DAYS = RUN_LOG_TTL_MS / (24 * 60 * 60 * 1000)
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000
// Calls per sweep at most, each deleting up to Nakama's own cap.
const MAX_CALLS = 50

type Rpc = <T>(id: string, body: Record<string, unknown>) => Promise<Result<T, NakamaRpcError>>

export interface RunPurgeDeps {
	rpc: Rpc
	// The reports and bans that use each run (retention gateway runLinks).
	runLinks(runIds: string[], now: Date): Promise<Map<string, EvidenceLink[]>>
}

// One sweep: pages through Nakama's old runs until the end. Returns how many
// runs went.
export async function purgeNakamaRuns(deps: RunPurgeDeps, now: Date): Promise<number> {
	let total = 0
	let cursor = ''
	for (let call = 0; call < MAX_CALLS; call++) {
		const page = await deps.rpc<{ runs: { runId: string; endedAt: number }[]; cursor: string }>(
			'admin_runs_expired',
			{ olderThanDays: RUN_RETENTION_DAYS, cursor },
		)
		if (!page.ok) {
			if (page.error !== 'disabled') console.warn(`[retention] run listing failed: ${page.error}`)
			return total
		}
		const { runs } = page.value
		const links = runs.length > 0 ? await deps.runLinks(runs.map((r) => r.runId), now) : new Map()
		const purgeable = runs
			.filter((r) => evidencePurgeable({ madeAt: new Date(r.endedAt), links: links.get(r.runId) ?? [] }, now))
			.map((r) => r.runId)
		for (let i = 0; i < purgeable.length; i += NAMED_RUNS_PER_CALL) {
			const purged = await deps.rpc<{ deleted: number }>('admin_runs_purge_named', {
				runIds: purgeable.slice(i, i + NAMED_RUNS_PER_CALL),
			})
			if (!purged.ok) {
				console.warn(`[retention] purge failed: ${purged.error}`)
				return total
			}
			total += purged.value.deleted
		}
		cursor = page.value.cursor
		if (!cursor) return total
	}
	return total
}

// One sweep of Nakama's expired lobby checkpoints: a game nobody came back to
// is stored there as "no contest". Same repeat rule as the run purge.
export async function sweepNakamaCheckpoints(rpc: Rpc): Promise<{ deleted: number; noContest: number }> {
	const total = { deleted: 0, noContest: 0 }
	for (let call = 0; call < MAX_CALLS; call++) {
		const result = await rpc<{ deleted: number; noContest: number; more: boolean }>('admin_checkpoints_sweep', {})
		if (!result.ok) {
			if (result.error !== 'disabled') console.warn(`[retention] checkpoint sweep failed: ${result.error}`)
			return total
		}
		total.deleted += result.value.deleted
		total.noContest += result.value.noContest
		if (!result.value.more) return total
	}
	return total
}

// Calls a purge RPC that answers {deleted, more} until Nakama has nothing
// more to delete. Returns how many went.
async function purgeUntilDone(rpc: Rpc, id: string, what: string): Promise<number> {
	let total = 0
	for (let call = 0; call < MAX_CALLS; call++) {
		const result = await rpc<{ deleted: number; more: boolean }>(id, {})
		if (!result.ok) {
			if (result.error !== 'disabled') console.warn(`[retention] ${what} purge failed: ${result.error}`)
			return total
		}
		total += result.value.deleted
		if (!result.value.more) return total
	}
	return total
}

// One sweep of the login network hashes (network bans, ADR 0005): Nakama
// deletes each 30 days after the last login from that network.
export function purgeNakamaIpHashes(rpc: Rpc): Promise<number> {
	return purgeUntilDone(rpc, 'admin_ip_hashes_purge', 'IP hash')
}

// One sweep of the account-ban index entries of deleted accounts whose ban
// has run out: they hold the Steam id hash (or device id hash) only to
// enforce the ban.
export function purgeNakamaBanIndex(rpc: Rpc): Promise<number> {
	return purgeUntilDone(rpc, 'admin_ban_index_purge', 'ban index')
}

export function startRetentionJob(): () => void {
	const sweep = () =>
		void purgeNakamaRuns({ rpc: callNakamaRpc, runLinks: retentionRepository.runLinks }, new Date())
			.then((deleted) => {
				if (deleted > 0) console.log(`[retention] purged ${deleted} Nakama runs`)
			})
			.catch((err) => console.error('[retention] purge failed:', err))
	const sweepCheckpoints = () =>
		void sweepNakamaCheckpoints(callNakamaRpc)
			.then(({ deleted, noContest }) => {
				if (deleted > 0) console.log(`[retention] swept ${deleted} Nakama checkpoints (${noContest} no contest)`)
			})
			.catch((err) => console.error('[retention] checkpoint sweep failed:', err))
	const purgeIpHashes = () =>
		void purgeNakamaIpHashes(callNakamaRpc)
			.then((deleted) => {
				if (deleted > 0) console.log(`[retention] purged ${deleted} Nakama login network hashes`)
			})
			.catch((err) => console.error('[retention] IP hash purge failed:', err))
	const purgeBanIndex = () =>
		void purgeNakamaBanIndex(callNakamaRpc)
			.then((deleted) => {
				if (deleted > 0) console.log(`[retention] purged ${deleted} Nakama ban index entries of deleted accounts`)
			})
			.catch((err) => console.error('[retention] ban index purge failed:', err))
	const all = () => {
		sweep()
		sweepCheckpoints()
		purgeIpHashes()
		purgeBanIndex()
	}
	all()
	const timer = setInterval(all, RETENTION_INTERVAL_MS)
	timer.unref()
	return () => clearInterval(timer)
}
