// Live (W5): inactivity decay, Nakama's read-time decay against the website's.
// Needs w5-seed.live.mjs's board. Backdates c's lastMatchAt by 20.5 days
// (-65) and d's by 200 days (floored at 100) in both Nakama storage and the
// Postgres mirror, then compares rating_get, leaderboard_get and
// /api/stats/{leaderboard,players/:id}. Finally c plays d once: the game must
// rate from the decayed rating, and the mirror must then store it.
// Run: BMP_TEST_PREFIX=w5test_ node nakama/scripts/live/w5-decay.live.mjs
import { check, express, poll, psql, q, rpc, sleep, summary } from './lib.mjs'
import { MOD, MODE, pgBoard, player, rankedGame } from './w5-seed.live.mjs'

const DAY = 86400000
const key = `${MOD}:${MODE}:1`

function backdate(p, days) {
	const at = Date.now() - days * DAY
	psql('nakama', `update storage set value = jsonb_set(value, '{lastMatchAt}', to_jsonb(${at}::bigint)) where collection='ratings' and key=${q(key)} and user_id=${q(p.userId)}`)
	psql('bmp', `update matchmaking_ratings set last_match_at = to_timestamp(${at / 1000}) where mod_id=${q(MOD)} and game_mode=${q('ranked:' + MODE)} and season=1 and player_id=(select id from players where nakama_user_id=${q(p.userId)})`)
}

const stored = (p) => JSON.parse(psql('nakama', `select value::text from storage where collection='ratings' and key=${q(key)} and user_id=${q(p.userId)}`)[0][0])
const pgId = (p) => psql('bmp', `select id from players where nakama_user_id=${q(p.userId)}`)[0][0]

async function views(p, viewer) {
	const nk = (await rpc(viewer.token, 'rating_get', { modId: MOD, mode: MODE, playerId: p.userId })).body
	const lb = (await rpc(viewer.token, 'leaderboard_get', { modId: MOD, mode: MODE })).body.entries.find((e) => e.playerId === p.userId)
	const web = (await express('GET', `/api/stats/leaderboard?modId=${MOD}&gameMode=ranked:${MODE}`)).body
	const webRow = (web.entries || web.rows || web.players || []).find((e) => JSON.stringify(e).includes(pgId(p)))
	const prof = (await express('GET', `/api/stats/players/${pgId(p)}?modId=${MOD}&gameMode=ranked:${MODE}`)).body
	return { stored: stored(p).rating, rating_get: nk.rating, leaderboard_get: lb && lb.rating, web_leaderboard: webRow && webRow.rating, web_player: prof && (prof.rating ?? (prof.player && prof.player.rating) ?? prof), raw: { webRow } }
}

async function main() {
	const [a, c, d] = [await player('a'), await player('c'), await player('d')]
	const base = { c: stored(c).rating, d: stored(d).rating }
	backdate(c, 20.5)
	backdate(d, 200)
	const vc = await views(c, a)
	const vd = await views(d, a)
	console.log('C', JSON.stringify(vc))
	console.log('D', JSON.stringify(vd))
	check('Nakama rating_get decays c by 13 whole days x5', vc.rating_get === base.c - 65, `${base.c} -> ${vc.rating_get}`)
	check('Nakama rating_get floors d at 100', vd.rating_get === 100, String(vd.rating_get))
	check('decay is read-only (stored rating untouched)', vc.stored === base.c && vd.stored === base.d)
	check('website /leaderboard agrees with rating_get (c)', vc.web_leaderboard === vc.rating_get, String(vc.web_leaderboard))
	check('website /leaderboard agrees with rating_get (d)', vd.web_leaderboard === vd.rating_get, String(vd.web_leaderboard))
	check('website /players/:id agrees with rating_get (c)', vc.web_player === vc.rating_get, String(vc.web_player))
	check('leaderboard_get agrees with rating_get (c)', vc.leaderboard_get === vc.rating_get, `leaderboard_get ${vc.leaderboard_get} vs rating_get ${vc.rating_get}`)

	// One more game: c beats d from the decayed ratings.
	const g = await rankedGame([c, d], new Map([[c, [c, d]], [d, [c, d]]]))
	check('decayed players can play a ranked game', g.status === 'agreed', g.status)
	const after = { c: stored(c), d: stored(d) }
	console.log('GAME', JSON.stringify(g.ratings), 'STORED', JSON.stringify(after))
	check('the game rated c from the decayed base (gain on top of base-65)', after.c.rating > vc.rating_get && after.c.rating < vc.rating_get + 40, `${vc.rating_get} -> ${after.c.rating}`)
	check('d rated from the floor', after.d.rating >= 100 && after.d.rating <= 100, String(after.d.rating))
	const mirrored = await poll(() => {
		const row = pgBoard().find((r) => r[0] === c.username)
		return row && Number(row[1]) === after.c.rating ? row : null
	}, 30000)
	check('mirror stores the post-game (decayed base) rating', !!mirrored, JSON.stringify(mirrored))
	for (const p of [a, c, d]) p.socket.close()
	await sleep(300)
	process.exitCode = summary('w5-decay') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
