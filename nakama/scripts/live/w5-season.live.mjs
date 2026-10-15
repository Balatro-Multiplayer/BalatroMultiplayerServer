// Live (W5): a season rollover through Express's hourly season job. Run AFTER
// the job has rolled the season (set seasons.ends_at into the past and wait
// for the hourly tick; nothing restarts). Needs w5-seed/w5-void/w5-decay's
// season-1 board. Checks:
//   - Postgres: season 1 ended, season 2 active; Nakama config season pushed.
//   - rating_get: season-2 rating is the soft reset of the season-1 rating
//     (lazy, nothing written), placement restarts.
//   - leaderboard_get / website /api/stats are per season (season 2 empty
//     until games; season=1 still readable on the website).
//   - a season-2 ranked game rates from the carried rating, writes board :2,
//     and is mirrored into Postgres season 2.
//   - optional (W5_SPDRN=1): c and d play 5 season-2 ranked games on the real
//     MultiplayerSPDRN gold_stake_single board so a client's leaderboard UI has
//     season-2 entries to show. Clean up with admin_ratings_set afterwards.
// Run: BMP_TEST_PREFIX=w5test_ node nakama/scripts/live/w5-season.live.mjs
import { admin, check, express, poll, psql, q, rpc, sendLog, sleep, startGame, summary } from './lib.mjs'
import { hostFirst } from './mirror.live.mjs'
import { MOD, MODE, nakamaBoard, pgBoard, player } from './w5-seed.live.mjs'

const softReset = (r) => Math.min(Math.round(600 + (r - 600) / 2), 1200)

async function matchmakeOn(modId, players, mode) {
	const query = `+properties.modId:${modId} +properties.mode:${mode} +properties.kind:ranked`
	const marks = players.map((p) => p.socket.mark())
	for (const p of players) {
		const t = await p.socket.request({
			matchmaker_add: { min_count: players.length, max_count: players.length, query, string_properties: { modId, mode, kind: 'ranked' } },
		})
		if (!t.matchmaker_ticket) throw new Error('matchmaker_add: ' + JSON.stringify(t))
	}
	const matched = await Promise.all(players.map((p, i) => p.socket.waitFor((x) => x.kind === 'matched', 20000, marks[i])))
	const matchId = matched[0].match_id
	for (const p of players) {
		const j = await p.socket.join(matchId, { modId, displayName: p.username })
		if (j.error) throw new Error('join: ' + JSON.stringify(j.error))
		await p.socket.waitFor((x) => x.kind === 'data' && x.op === 100, 5000)
	}
	return psql('nakama', `select key from storage where collection='lobby_codes' and value->>'matchId'=${q(matchId)}`)[0][0]
}

async function game(modId, mode, [w, l]) {
	const code = await matchmakeOn(modId, [w, l], mode)
	const ordered = await hostFirst(code, [w, l])
	const { runId } = await startGame(ordered, {})
	for (const p of [w, l]) await sendLog(p.socket, runId, [[1, 'start', { deck: 'b_red' }], [2, 'end', {}]])
	await sleep(300)
	const since = w.socket.mark()
	for (const p of [w, l]) await p.socket.ask('mpapi_report_result', { placements: [{ playerId: w.userId, place: 1 }, { playerId: l.userId, place: 2 }] })
	const end = await w.socket.waitFor((x) => x.kind === 'data' && x.op === 101 && x.data.type === 'game_ended', 15000, since)
	for (const p of [w, l]) p.socket.sendOp(1, {})
	await sleep(700)
	return end && end.data.data
}

async function main() {
	const seasons = psql('bmp', 'select id, ended_at is null, name from seasons order by id')
	console.log('SEASONS', JSON.stringify(seasons))
	check('season job ended season 1 and opened season 2', seasons.length === 2 && seasons[0][1] === 'f' && seasons[1][0] === '2' && seasons[1][1] === 't', JSON.stringify(seasons))
	const cfg = JSON.parse(psql('nakama', "select value::text from storage where collection='server_config' and key='global'")[0][0])
	check('Express pushed season 2 to Nakama', cfg.season === 2, JSON.stringify(cfg))

	const [a, b, c, d] = [await player('a'), await player('b'), await player('c'), await player('d')]
	const s1 = Object.fromEntries(nakamaBoard(1).map((r) => [r[0], { rating: Number(r[1]), games: Number(r[2]) }]))
	console.log('SEASON1', JSON.stringify(s1))
	for (const p of [a, b, c, d]) {
		const r = (await rpc(p.token, 'rating_get', { modId: MOD, mode: MODE })).body
		const want = softReset(s1[p.username].rating)
		check(`${p.username}: season-2 rating_get = softReset(${s1[p.username].rating}) = ${want}, placement again`, r.rating === want && r.gamesPlayed === 0 && r.isPlacement === true, JSON.stringify(r))
	}
	check('carry-over is lazy (no season-2 objects yet)', nakamaBoard(2).length === 0, JSON.stringify(nakamaBoard(2)))
	const lb2 = (await rpc(a.token, 'leaderboard_get', { modId: MOD, mode: MODE })).body
	check('leaderboard_get reads the season-2 board (empty)', lb2.entries.length === 0, JSON.stringify(lb2))
	const web2 = await express('GET', `/api/stats/leaderboard?modId=${MOD}&gameMode=ranked:${MODE}`)
	const web1 = await express('GET', `/api/stats/leaderboard?modId=${MOD}&gameMode=ranked:${MODE}&season=1`)
	console.log('WEB2', web2.status, web2.text.slice(0, 300))
	console.log('WEB1', web1.status, web1.text.slice(0, 200))
	const rows = (x) => (x.body && (x.body.entries || x.body.rows || x.body.players)) || []
	check('website defaults to season 2 (empty)', web2.status === 200 && rows(web2).length === 0, web2.text.slice(0, 200))
	check('website season=1 still has the season-1 board', web1.status === 200 && rows(web1).length === 4, web1.text.slice(0, 200))
	const seasonsApi = (await express('GET', '/api/stats/seasons')).body
	check('/api/stats/seasons current = 2', seasonsApi.current === 2, JSON.stringify(seasonsApi))

	// A season-2 game: a beats b from their carried ratings.
	const end = await game(MOD, MODE, [a, b])
	console.log('S2 GAME', JSON.stringify(end && end.ratings))
	const s2 = Object.fromEntries(nakamaBoard(2).map((r) => [r[0], { rating: Number(r[1]), games: Number(r[2]) }]))
	check('season-2 game writes board :2 from the carried rating', s2[a.username] && s2[a.username].games === 1 && s2[a.username].rating > softReset(s1[a.username].rating) && s2[b.username].rating < softReset(s1[b.username].rating), JSON.stringify(s2))
	check('season-1 board untouched by the season-2 game', nakamaBoard(1).find((r) => r[0] === a.username)[2] === String(s1[a.username].games))
	const pg2 = await poll(() => (pgBoard(2).length === 2 ? pgBoard(2) : null), 30000)
	check('mirror writes Postgres season-2 rows equal to Nakama', !!pg2 && pg2.every((r) => s2[r[0]] && Number(r[1]) === s2[r[0]].rating), JSON.stringify(pg2))
	check('placement player stays off the season-2 board', (await rpc(a.token, 'leaderboard_get', { modId: MOD, mode: MODE })).body.entries.length === 0)

	if (process.env.W5_SPDRN === '1') {
		for (let i = 0; i < 5; i++) {
			const e = await game('MultiplayerSPDRN', 'spdrn_gold_stake_single', i === 3 ? [d, c] : [c, d])
			check(`SPDRN season-2 game ${i + 1}`, e && e.status === 'agreed', e && e.status)
		}
		const lb = (await rpc(a.token, 'leaderboard_get', { modId: 'MultiplayerSPDRN', mode: 'spdrn_gold_stake_single' })).body
		console.log('SPDRN S2 LEADERBOARD', JSON.stringify(lb))
		check('SPDRN season-2 board has c and d', lb.entries.length === 2, JSON.stringify(lb))
	}
	for (const p of [a, b, c, d]) p.socket.close()
	await sleep(300)
	process.exitCode = summary('w5-season') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
