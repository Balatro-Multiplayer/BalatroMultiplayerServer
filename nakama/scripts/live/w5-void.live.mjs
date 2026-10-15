// Live (W5): a wrongful-forfeit flag on a matchmade RANKED game, voided
// through the webadmin route, and how Nakama's and Postgres's boards compare
// afterwards. Needs w5-seed.live.mjs's board first. Takes ~2.5 minutes (the
// real 120s grace).
//   1. a vs b ranked; b's socket drops mid-game; after the grace b is removed
//      and a `forfeits` storage row is written (matchmade lobbies only).
//   2. b's session_init within 60s files the reconciliation entry; a's lone
//      report settles the game as partial and rates it.
//   3. PATCH /api/webadmin/forfeit-reconciliation/:id/void as a w5test admin:
//      Express replays the scope with its own Elo and calls admin_ratings_set.
// Run: BMP_TEST_PREFIX=w5test_ node nakama/scripts/live/w5-void.live.mjs
import { PREFIX, check, express, poll, psql, q, rpc, sleep, startGame, summary, webJwt } from './lib.mjs'
import { hostFirst, matchmake } from './mirror.live.mjs'
import { MOD, MODE, nakamaBoard, pgBoard, player } from './w5-seed.live.mjs'

const ended = (s, since, timeoutMs) =>
	s.waitFor((x) => x.kind === 'data' && x.op === 101 && x.data.type === 'game_ended', timeoutMs, since)

function adminPlayer() {
	const name = PREFIX + 'admin'
	const found = psql('bmp', `select id from players where steam_name=${q(name)}`)
	if (found.length) return found[0][0]
	return psql('bmp', `insert into players (steam_name, privileges) values (${q(name)}, '{admin}') returning id`)[0][0]
}

const asMap = (rows) => Object.fromEntries(rows.map((r) => [r[0], { rating: Number(r[1]), games: Number(r[2]), wins: Number(r[3]), losses: Number(r[4]) }]))

async function main() {
	const [a, b] = [await player('a'), await player('b')]
	const before = asMap(nakamaBoard())
	console.log('BEFORE (nakama)', JSON.stringify(before))

	const { code } = await matchmake([a, b], MODE, 'ranked')
	const [host, other] = await hostFirst(code, [a, b])
	const started = await startGame([host, other], {})
	const runId = started.runId
	const t0 = Date.now()
	other.socket.close()
	const left = await host.socket.waitFor(
		(x) => x.kind === 'data' && x.op === 101 && x.data.type === 'player_left' && JSON.stringify(x.data).includes(other.userId),
		200000,
	)
	check('grace: dropped ranked player removed after ~120s', !!left, `${((Date.now() - t0) / 1000).toFixed(1)}s`)
	const forfeitRow = psql('nakama', `select key, value::text from storage where collection='forfeits' and user_id=${q(other.userId)}`)
	check('matchmade ranked: forfeits storage row written', forfeitRow.some((r) => r[0] === runId), JSON.stringify(forfeitRow))
	await rpc(other.token, 'session_init', { steamName: other.username })
	const since = host.socket.mark()
	const r = await host.socket.ask('mpapi_report_result', {
		placements: [
			{ playerId: host.userId, place: 1 },
			{ playerId: other.userId, place: 2 },
		],
	})
	const end = await ended(host.socket, since, 15000)
	check('lone report settles the ranked game as partial', r.ok && end && end.data.data.status === 'partial', JSON.stringify(end && end.data.data))
	host.socket.sendOp(1, {})

	const flag = await poll(() => {
		const rows = psql(
			'bmp',
			`select f.id, f.match_id, f.status from forfeit_reconciliation_flags f join players p on p.id = f.player_id where p.nakama_user_id=${q(other.userId)} and f.match_id=${q(runId)}`,
		)
		return rows.length ? rows[0] : null
	}, 30000)
	check('reconciliation flag mirrored', !!flag && flag[2] === 'open', JSON.stringify(flag))
	await poll(() => {
		const m = psql('bmp', `select status from matchmaking_matches where match_id=${q(runId)}`)
		return m.length ? m : null
	}, 20000)
	const forfeited = asMap(nakamaBoard())
	console.log('AFTER FORFEIT (nakama)', JSON.stringify(forfeited))
	console.log('AFTER FORFEIT (pg)    ', JSON.stringify(asMap(pgBoard())))
	check('the forfeit game was rated (a up, b down)', forfeited[a.username].rating > before[a.username].rating && forfeited[b.username].rating < before[b.username].rating)

	const jwt = webJwt(adminPlayer(), PREFIX + 'admin')
	const res = await express('PATCH', `/api/webadmin/forfeit-reconciliation/${flag[0]}/void`, { token: jwt, body: { resolutionNotes: 'w5 void test' } })
	check('webadmin void returns 200 + voided flag', res.status === 200 && res.body.flag.status === 'voided', `${res.status} ${res.text.slice(0, 200)}`)
	const m = psql('bmp', `select status from matchmaking_matches where match_id=${q(runId)}`)
	check('matchmaking_matches row voided', m[0][0] === 'voided', JSON.stringify(m))

	await sleep(500)
	const nk = asMap(nakamaBoard())
	const pg = asMap(pgBoard())
	console.log('AFTER VOID (nakama)', JSON.stringify(nk))
	console.log('AFTER VOID (pg)    ', JSON.stringify(pg))
	for (const name of Object.keys(pg)) {
		check(`${name}: Nakama == Postgres after the void`, JSON.stringify(nk[name]) === JSON.stringify(pg[name]), `nk ${JSON.stringify(nk[name])} pg ${JSON.stringify(pg[name])}`)
	}
	// What a perfect void restores: the board as it was before the voided game.
	for (const name of Object.keys(before)) {
		const gap = (nk[name] ? nk[name].rating : NaN) - before[name].rating
		console.log(`GAP ${name}: rebuilt ${nk[name] && JSON.stringify(nk[name])} vs pre-game ${JSON.stringify(before[name])} -> rating gap ${gap}`)
	}
	const lb = await rpc(a.token, 'leaderboard_get', { modId: MOD, mode: MODE })
	console.log('LEADERBOARD', lb.text.slice(0, 600))
	console.log('OUT ' + JSON.stringify({ runId, flagId: flag[0] }))
	a.socket.close()
	b.socket.close()
	await sleep(300)
	process.exitCode = summary('w5-void') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
