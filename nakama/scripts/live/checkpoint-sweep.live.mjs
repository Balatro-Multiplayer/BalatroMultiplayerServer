// Live: the checkpoint sweep (admin_checkpoints_sweep) on the local stack. A
// checkpoint row is written straight into Postgres (no Nakama restart needed),
// then swept with a short ttlMs.
//  - an old row with a started game: swept, stored as an `abandoned` run (no
//    contest), no rating written, a mirror entry queued, the row gone
//  - an old row with no game: swept, no run
//  - a fresh row: kept (with the default TTL), then swept with ttlMs 0
// Look in `docker logs bmp-nakama` for "ended as no contest" (moderator log).
// Run: BMP_TEST_PREFIX=F8_ node nakama/scripts/live/checkpoint-sweep.live.mjs
import { admin, check, deviceAuth, psql, q, startSession, summary } from './lib.mjs'

const stamp = Date.now().toString(36)
const SYSTEM = '00000000-0000-0000-0000-000000000000'

async function player(name) {
	const p = await deviceAuth(`cs_${stamp}_${name}`)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await startSession(p)
	return p
}

function lobbyJson(code, players, runId) {
	return {
		code,
		modId: 'MultiplayerPvP',
		rankedMode: 'ranked_1v1',
		allowedIds: null,
		closed: false,
		players: players.map((p) => ({ id: p.userId, sessionId: '', awaySince: 1 })),
		spectators: [],
		game: {
			started: runId
				? {
						runId,
						seed: 'S',
						stake: 1,
						options: null,
						startedAt: 1,
						hostId: players[0].userId,
						players: players.map((p) => ({ id: p.userId, displayName: p.name || 'x' })),
					}
				: null,
			reports: {},
			reportOrder: [],
			logs: {},
			settleFrom: null,
		},
	}
}

function insertCheckpoint(code, lobby, at) {
	const value = JSON.stringify({ lobby, at, claimedAt: null })
	psql(
		'nakama',
		`insert into storage (collection, key, user_id, value, version, read, write, create_time, update_time)
		 values ('lobby_checkpoints', ${q(code)}, '${SYSTEM}', ${q(value)}::jsonb, md5(${q(value)}), 0, 0, now(), now())`,
	)
}

const rowCount = (code) =>
	Number(psql('nakama', `select count(*) from storage where collection='lobby_checkpoints' and key=${q(code)}`)[0][0])
const ratingRows = (ids) =>
	Number(psql('nakama', `select count(*) from storage where collection='ratings' and user_id in (${ids.map(q).join(',')})`)[0][0])

async function main() {
	const [a, b] = [await player('a'), await player('b')]
	const gameCode = `CS${stamp}G`.toUpperCase().slice(0, 8)
	const emptyCode = `CS${stamp}E`.toUpperCase().slice(0, 8)
	const freshCode = `CS${stamp}F`.toUpperCase().slice(0, 8)
	const runId = `cs-run-${stamp}`
	const now = Date.now()

	insertCheckpoint(gameCode, lobbyJson(gameCode, [a, b], runId), now - 3_600_000)
	insertCheckpoint(emptyCode, lobbyJson(emptyCode, [a, b], null), now - 3_600_000)
	insertCheckpoint(freshCode, lobbyJson(freshCode, [a, b], null), now)

	const first = await admin('admin_checkpoints_sweep', {})
	check('sweep: the RPC answers', first.ok, first.text)
	check('sweep: the old game checkpoint is gone', rowCount(gameCode) === 0)
	check('sweep: the old empty checkpoint is gone', rowCount(emptyCode) === 0)
	check('sweep: the fresh checkpoint is kept', rowCount(freshCode) === 1)

	const run = psql('nakama', `select value from storage where collection='match_runs' and key=${q(runId)}`)
	const rec = run.length ? JSON.parse(run[0][0]) : null
	check('no contest: the game is stored as an abandoned run with no placements', rec && rec.status === 'abandoned' && rec.placements.length === 0, rec && rec.status)
	check('no contest: no rating row was written', ratingRows([a.userId, b.userId]) === 0)
	check(
		'no contest: the API mirror has the run queued',
		psql('nakama', `select count(*) from storage where collection='mirror_outbox' and value->>'runId'=${q(runId)}`)[0][0] === '1',
	)

	const second = await admin('admin_checkpoints_sweep', { ttlMs: 0 })
	check('short ttl: a fresh checkpoint goes with ttlMs 0', second.ok && rowCount(freshCode) === 0, second.text)
	const bad = await admin('admin_checkpoints_sweep', { ttlMs: -1 })
	check('short ttl: a negative ttlMs is refused', !bad.ok, bad.text)
	const noKey = await admin('admin_checkpoints_sweep', {}, 'wrong-key')
	check('sweep: refused without the http key', !noKey.ok, noKey.text)

	process.exit(summary('checkpoint-sweep') ? 1 : 0)
}

main().catch((e) => {
	console.error(e)
	process.exit(2)
})
