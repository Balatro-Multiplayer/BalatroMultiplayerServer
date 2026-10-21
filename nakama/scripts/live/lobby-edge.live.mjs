// Live: lobby timeouts at their real (env-default) lengths. Takes ~3 minutes.
//  - Forfeit: a matchmade player's socket drops mid-game; after the 120s grace
//    they are removed and a forfeit stored; the remaining reporter settles the
//    game as partial; the forfeited player's session_init within 60s files a
//    forfeit_reconciliation_flags row through the mirror.
//  - Partial: in a private game one player reports and the other never does;
//    the 60s result clock ends it as partial.
// Run: node nakama/scripts/live/lobby-edge.live.mjs
import { PREFIX, ServerOp, check, connect, deviceAuth, lobbyWith, poll, psql, q, rpc, sleep, startGame, startSession, summary } from './lib.mjs'
import { hostFirst, matchmake } from './mirror.live.mjs'

const stamp = Date.now().toString(36)

async function player(name) {
	const p = await deviceAuth(`le_${stamp}_${name}`)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await startSession(p)
	p.socket = await connect(p)
	return p
}

const ended = (s, since, timeoutMs) =>
	s.waitFor((x) => x.kind === 'data' && x.op === ServerOp.EVENT && x.data.type === 'game_ended', timeoutMs, since)

async function forfeitScenario() {
	const a = await player('fa')
	const b = await player('fb')
	const { code } = await matchmake([a, b], `${PREFIX}ff_${stamp}`)
	const [host, other] = await hostFirst(code, [a, b])
	const started = await startGame([host, other], { stake: 1 })
	const runId = started.runId
	const dropAt = Date.now()
	other.socket.close() // drops mid-game, no LEAVE

	const left = await host.socket.waitFor(
		(x) => x.kind === 'data' && x.op === ServerOp.EVENT && x.data.type === 'player_left' && JSON.stringify(x.data).includes(other.userId),
		200000,
	)
	const graceS = (Date.now() - dropAt) / 1000
	check('forfeit: dropped player removed after the grace', !!left && graceS >= 115 && graceS < 140, `${graceS.toFixed(1)}s`)
	const stored = psql('nakama', `select key from storage where collection='forfeits' and user_id=${q(other.userId)}`)
	check('forfeit: stored for the dropped player', stored.some((r) => r[0] === runId), JSON.stringify(stored))

	// Back within the window: session_init files the reconciliation entry.
	await startSession(other)
	const gone = psql('nakama', `select count(*) from storage where collection='forfeits' and user_id=${q(other.userId)}`)[0][0]
	check('forfeit: forgotten after the return', gone === '0', gone)

	const since = host.socket.mark()
	const r = await host.socket.ask('mpapi_report_result', {
		placements: [
			{ playerId: host.userId, place: 1 },
			{ playerId: other.userId, place: 2 },
		],
	})
	const end = await ended(host.socket, since, 10000)
	check('forfeit: lone reporter settles it as partial', r.ok && end && end.data.data.status === 'partial', JSON.stringify(end && end.data.data))

	const flag = await poll(() => {
		const rows = psql(
			'bmp',
			`select f.status, f.lobby_code from forfeit_reconciliation_flags f join players p on p.id = f.player_id
			 where p.nakama_user_id = ${q(other.userId)}`,
		)
		return rows.length ? rows : null
	}, 30000)
	check('forfeit: reconciliation flag mirrored to Postgres', !!flag && flag[0][1] === code, JSON.stringify(flag))
	host.socket.close()
	return { flagged: other }
}

async function partialScenario() {
	const a = await player('pa')
	const b = await player('pb')
	await lobbyWith([a, b])
	const started = await startGame([a, b], { stake: 1 })
	const since = a.socket.mark()
	const t0 = Date.now()
	const r = await a.socket.ask('mpapi_report_result', {
		placements: [
			{ playerId: a.userId, place: 1 },
			{ playerId: b.userId, place: 2 },
		],
	})
	check('partial: first report accepted', r.ok, JSON.stringify(r))
	const end = await ended(a.socket, since, 80000)
	const s = (Date.now() - t0) / 1000
	check('partial: ends as partial after the 60s result clock', !!end && end.data.data.status === 'partial' && s >= 58 && s < 70, `${s.toFixed(1)}s ${JSON.stringify(end && end.data.data)}`)
	const run = await rpc(b.token, 'run_get', { runId: started.runId })
	check('partial: stored run is partial with the one report', run.ok && run.body.status === 'partial' && Object.keys(run.body.reports || {}).length === 1, run.text.slice(0, 160))
	a.socket.close()
	b.socket.close()
}

async function main() {
	await Promise.all([forfeitScenario(), partialScenario()])
	await sleep(300)
	process.exitCode = summary('lobby-edge.live') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
