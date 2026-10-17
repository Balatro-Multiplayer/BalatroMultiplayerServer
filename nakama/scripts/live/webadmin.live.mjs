// Live: Express's webadmin and public HTTP routes against what Nakama and the
// mirror produced. Runs mirror.live.mjs first for fresh runs (an agreed run
// with a flagged log, a disputed matchmade run and its conflict), then drives
// /api/webadmin, /api/runs, /api/stats and /health as throwaway admin,
// moderator and plain players (players rows inserted directly, JWTs signed
// with the API container's JWT_SECRET). Config routes are read only.
// Run: node nakama/scripts/live/webadmin.live.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
	PREFIX,
	ServerOp,
	admin,
	check,
	deviceAuth,
	express,
	lobbyWith,
	poll,
	psql,
	q,
	rpc,
	sleep,
	summary,
	webJwt,
} from './lib.mjs'

function staffRow(name, privileges) {
	psql(
		'bmp',
		`insert into players (steam_name, privileges) select ${q(name)}, ${q(`{${privileges.join(',')}}`)}::text[]
		 where not exists (select 1 from players where steam_name = ${q(name)})`,
	)
	const id = psql('bmp', `select id from players where steam_name = ${q(name)} order by created_at limit 1`)[0][0]
	return { id, token: webJwt(id, name) }
}

function pgId(nakamaUserId) {
	const rows = psql('bmp', `select id from players where nakama_user_id = ${q(nakamaUserId)}`)
	return rows.length ? rows[0][0] : null
}

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	return p
}

async function main() {
	// Fresh mirrored runs to look at.
	const mirrorOut = execFileSync('node', [fileURLToPath(new URL('./mirror.live.mjs', import.meta.url))], {
		encoding: 'utf8',
		timeout: 300000,
	})
	const line = mirrorOut.split('\n').find((l) => l.startsWith('OUTPUTS '))
	check('mirror.live ran clean as a fixture', /mirror\.live: \d+ passed, 0 failed/.test(mirrorOut))
	const out = JSON.parse(line.slice('OUTPUTS '.length))
	const outsider = psql('bmp', `select id from players where steam_name = ${q(PREFIX + 'mir_3')}`)[0][0]

	const adm = staffRow(PREFIX + 'admin', ['admin'])
	const mod = staffRow(PREFIX + 'moder', ['moderator'])
	const plain = staffRow(PREFIX + 'plain', [])

	// --- auth gate ---
	const W = '/api/webadmin'
	check('no token: 401', (await express('GET', `${W}/players`)).status === 401)
	check('bad signature: 401', (await express('GET', `${W}/players`, { token: adm.token.slice(0, -2) + 'xx' })).status === 401)
	check('plain player: 403', (await express('GET', `${W}/players`, { token: plain.token })).status === 403)
	check('moderator allowed', (await express('GET', `${W}/players`, { token: mod.token })).status === 200)

	// --- players ---
	const list = await express('GET', `${W}/players?search=${PREFIX}mir`, { token: adm.token })
	check(
		'players search finds mirrored device players',
		list.ok && list.body.players.some((p) => p.id === out.honestPlayer) && list.body.players.every((p) => p.steamName.startsWith(PREFIX)),
		`total ${list.body && list.body.total}`,
	)
	const one = await express('GET', `${W}/players/${out.honestPlayer}`, { token: adm.token })
	check('players/:id', one.ok && one.body.player.id === out.honestPlayer && Array.isArray(one.body.bans))
	const badUuid = await express('GET', `${W}/players/not-a-uuid`, { token: adm.token })
	check('players/:id malformed id answers 4xx (not 500; f12644c needs deploy)', badUuid.status >= 400 && badUuid.status < 500, `${badUuid.status}`)
	check('players/:id unknown: 404', (await express('GET', `${W}/players/00000000-0000-0000-0000-000000000000`, { token: adm.token })).status === 404)
	check(
		'moderator cannot change privileges (403)',
		(await express('PATCH', `${W}/players/${mod.id}/privileges`, { token: mod.token, body: { privileges: ['admin'] } })).status === 403,
	)
	check(
		'privileges validated (400)',
		(await express('PATCH', `${W}/players/${plain.id}/privileges`, { token: adm.token, body: { privileges: 'admin' } })).status === 400,
	)
	const grant = await express('PATCH', `${W}/players/${plain.id}/privileges`, { token: adm.token, body: { privileges: ['moderator'] } })
	check('admin grants moderator', grant.ok && grant.body.privileges.includes('moderator'))
	check('grant takes effect at once', (await express('GET', `${W}/players`, { token: plain.token })).status === 200)
	await express('PATCH', `${W}/players/${plain.id}/privileges`, { token: adm.token, body: { privileges: [] } })
	check('revoke takes effect at once', (await express('GET', `${W}/players`, { token: plain.token })).status === 403)

	// --- lobbies, reports, bans through a live lobby ---
	const stamp = Date.now().toString(36)
	const a = await player(`wa_${stamp}_a`)
	const b = await player(`wa_${stamp}_b`)
	const { code, sockets } = await lobbyWith([a, b])
	const lobbies = await poll(async () => {
		const r = await express('GET', `${W}/lobbies?search=${code}`, { token: mod.token })
		return r.ok && r.body.lobbies.some((l) => l.code === code && l.playerCount === 2) ? r : null
	}, 8000)
	check('lobbies list finds it by code', !!lobbies)
	const lob = await express('GET', `${W}/lobbies/${code}`, { token: mod.token })
	check('lobbies/:code', lob.ok && lob.body.lobby.code === code && lob.body.players.length === 2, JSON.stringify(lob.body).slice(0, 200))
	check('lobbies/:code unknown: 404', (await express('GET', `${W}/lobbies/ZZZZZZ`, { token: mod.token })).status === 404)

	// Report rate limit: 5 per 10 minutes, the 6th refused (fresh reporter).
	const filed = []
	for (let i = 0; i < 5; i++) {
		const r = await rpc(a.token, 'report_submit', { reportedUserId: b.userId, type: 'other', message: `h1test report ${i}` })
		filed.push(r)
	}
	check('5 reports filed', filed.every((r) => r.ok && typeof r.body.reportId === 'number'), filed.map((r) => r.status).join(','))
	const sixth = await rpc(a.token, 'report_submit', { reportedUserId: b.userId, type: 'other' })
	check('6th report in the window refused', !sixth.ok && /Too many reports/.test(sixth.text), sixth.text.slice(0, 120))
	check(
		'self-report refused',
		!(await rpc(b.token, 'report_submit', { reportedUserId: b.userId, type: 'other' })).ok,
	)
	check('bad report type refused', !(await rpc(b.token, 'report_submit', { reportedUserId: a.userId, type: 'nope' })).ok)
	const pa = pgId(a.userId)
	const reps = await express('GET', `${W}/reports?limit=100`, { token: mod.token })
	// Device players have no players row: the report keeps their Nakama id.
	const mine = reps.ok ? reps.body.reports.filter((r) => r.reporterId === (pa || a.userId)) : []
	check('reports list shows the 5 reports with lobby code', mine.length === 5 && mine.every((r) => r.lobbyCode === code), `${mine.length}`)
	if (mine[0]) {
		const det = await express('GET', `${W}/reports/${mine[0].id}`, { token: mod.token })
		check('reports/:id', det.ok, det.text.slice(0, 160))
	}

	// Ban through webadmin: queue ban on b, then lift.
	// Bans need a players row: use a mirrored device player (has one).
	const pb = out.honestPlayer
	const nkB = psql('bmp', `select nakama_user_id from players where id = ${q(pb)}`)[0][0]
	const ban = await express('POST', `${W}/players/${pb}/bans`, { token: mod.token, body: { type: 'queue', reason: 'h1test' } })
	check('webadmin queue ban issued', ban.status === 201 && ban.body.ban, ban.text.slice(0, 160))
	const nkBans = await poll(async () => {
		const g = await admin('admin_player_get', { userId: nkB })
		const bans = g.body && (g.body.bans || (g.body.moderation && g.body.moderation.bans))
		return g.ok && JSON.stringify(g.body).includes('queue') ? g.body : null
	}, 8000)
	check('ban reached Nakama', !!nkBans, nkBans ? '' : 'admin_player_get shows no queue ban')
	check('bad ban type: 400', (await express('POST', `${W}/players/${pb}/bans`, { token: mod.token, body: { type: 'forever' } })).status === 400)
	if (ban.body && ban.body.ban) {
		const lift = await express('DELETE', `${W}/players/${pb}/bans/${ban.body.ban.id}`, { token: mod.token })
		check('webadmin ban lifted', lift.ok, lift.text.slice(0, 160))
		check('lifting again: 404', (await express('DELETE', `${W}/players/${pb}/bans/${ban.body.ban.id}`, { token: mod.token })).status === 404)
	}

	// Kick then close.
	const sinceB = sockets[1].mark()
	const kick = await express('POST', `${W}/lobbies/${code}/kick/${b.userId}`, { token: mod.token })
	check('webadmin kick', kick.ok, kick.text)
	const kicked = await sockets[1].waitFor(
		(i) => i.kind === 'data' && i.op === ServerOp.EVENT && JSON.stringify(i.data).includes('kick'),
		5000,
		sinceB,
	)
	check('kicked player told', !!kicked, kicked ? JSON.stringify(kicked.data).slice(0, 120) : '')
	const after = await admin('admin_lobby_get', { code })
	const seated = after.ok && (after.body.lobby || after.body).players
	check('lobby has 1 player after kick', !!seated && seated.length === 1, after.text.slice(0, 160))
	check('kick unknown player: 404', (await express('POST', `${W}/lobbies/${code}/kick/${b.userId}`, { token: mod.token })).status === 404)
	const close = await express('POST', `${W}/lobbies/${code}/close`, { token: mod.token })
	check('webadmin close', close.ok, close.text)
	const gone = await poll(async () => ((await express('GET', `${W}/lobbies/${code}`, { token: mod.token })).status === 404 ? true : null), 6000)
	check('closed lobby gone', !!gone)
	check('close unknown: 404', (await express('POST', `${W}/lobbies/ZZZZZZ/close`, { token: mod.token })).status === 404)

	// --- service queue ---
	const sq = await express('GET', `${W}/service-queue?itemType=anti_cheat&limit=100`, { token: mod.token })
	const ac = sq.ok ? sq.body.items.find((i) => i.sourceId === out.runA) : null
	check('service queue has the anti_cheat item for runA', !!ac, `${sq.status} ${sq.body && sq.body.total}`)
	if (ac) {
		const d = await express('GET', `${W}/service-queue/${ac.id}`, { token: mod.token })
		check('service-queue/:id detail', d.ok, d.text.slice(0, 200))
	}
	const mc = await express('GET', `${W}/service-queue?itemType=match_conflict&limit=100`, { token: mod.token })
	check('service queue has the match_conflict item', mc.ok && mc.body.items.some((i) => String(i.sourceId) === String(out.conflictId)))
	check('service-queue/:id bad id: 400', (await express('GET', `${W}/service-queue/abc`, { token: mod.token })).status === 400)

	// --- match conflicts ---
	const cl = await express('GET', `${W}/match-conflicts?limit=100`, { token: mod.token })
	check('match-conflicts lists it', cl.ok && cl.body.conflicts.some((c) => String(c.id) === String(out.conflictId)))
	const res = await express('PATCH', `${W}/match-conflicts/${out.conflictId}/resolve`, {
		token: mod.token,
		body: { resolutionNotes: 'h1test resolve' },
	})
	check('conflict resolved', res.ok && res.body.conflict.status !== 'open', res.text.slice(0, 160))
	check(
		'resolve notes type checked (400)',
		(await express('PATCH', `${W}/match-conflicts/${out.conflictId}/resolve`, { token: mod.token, body: { resolutionNotes: 5 } })).status === 400,
	)
	check('resolve unknown: 404', (await express('PATCH', `${W}/match-conflicts/999999999/resolve`, { token: mod.token, body: {} })).status === 404)

	// --- read-only lists ---
	for (const path of ['forfeit-reconciliation', 'matches', 'chat-logs', 'config', 'seasons', 'reports']) {
		const r = await express('GET', `${W}/${path}`, { token: mod.token })
		check(`GET ${W}/${path}: 200`, r.ok, r.ok ? '' : r.text.slice(0, 160))
	}

	// --- /api/runs ---
	const honest = webJwt(out.honestPlayer, PREFIX + 'mir_1')
	const runs = await express('GET', '/api/runs/mine', { token: honest })
	check('runs/mine lists runA', runs.ok && JSON.stringify(runs.body).includes(out.runA), runs.text.slice(0, 160))
	check('runs/mine needs auth', (await express('GET', '/api/runs/mine')).status === 401)
	const rp = await express('GET', `/api/runs/${out.runA}/replay`, { token: honest })
	check('replay: participant 200', rp.ok, rp.text.slice(0, 160))
	const ro = await express('GET', `/api/runs/${out.runA}/replay`, { token: webJwt(outsider, PREFIX + 'mir_3') })
	check('replay: non-participant refused', ro.status === 403 || ro.status === 404, `${ro.status}`)
	const rm = await express('GET', `/api/runs/${out.runA}/replay`, { token: mod.token })
	check('replay: moderator 200', rm.ok, rm.text.slice(0, 160))
	check('replay: unknown run 404', (await express('GET', `/api/runs/00000000-0000-0000-0000-000000000000/replay`, { token: mod.token })).status === 404)

	// --- /api/stats and /health ---
	const board = `modId=${PREFIX}mod&gameMode=${encodeURIComponent('ranked:' + PREFIX + 'rk')}`
	for (const path of ['', '/seasons', '/activity', '/season-overview', '/history', '/stake-popularity']) {
		const r = await express('GET', `/api/stats${path}`)
		check(`GET /api/stats${path}: 200`, r.ok, r.ok ? '' : `${r.status} ${r.text.slice(0, 160)}`)
	}
	check('leaderboard without modId: 400', (await express('GET', '/api/stats/leaderboard')).status === 400)
	// Players still in placement (under 5 games) are kept off the board, as on
	// Nakama's leaderboard_get; mirror.live adds one ranked game per run.
	const lb = await express('GET', `/api/stats/leaderboard?${board}`)
	const established = psql(
		'bmp',
		`select player_id from matchmaking_ratings where mod_id=${q(PREFIX + 'mod')} and game_mode=${q('ranked:' + PREFIX + 'rk')}
		   and season=${Number(lb.body && lb.body.season)} and games_played >= 5 order by 1`,
	).map((r) => r[0])
	const listed = lb.ok ? lb.body.entries.map((e) => e.playerId).sort() : null
	check(
		'leaderboard lists exactly the mirrored players past placement',
		!!listed && JSON.stringify(listed) === JSON.stringify(established),
		`listed ${JSON.stringify(listed)} established ${JSON.stringify(established)}`,
	)
	const ps = await express('GET', `/api/stats/players/${out.honestPlayer}?${board}`)
	check('stats/players/:id', ps.ok, ps.text.slice(0, 200))
	// Malformed ids/numbers: 400, never a 500 (fixed in f12644c, needs deploy).
	for (const [method, path, body] of [
		['GET', `${W}/players/not-a-uuid`],
		['POST', `${W}/players/not-a-uuid/bans`, { type: 'queue', reason: 'h2test' }],
		['DELETE', `${W}/players/not-a-uuid/bans/1`],
		['DELETE', `${W}/players/${out.honestPlayer}/bans/not-a-uuid`],
		['GET', `/api/stats/players/not-a-uuid?${board}`],
		['GET', `/api/stats/leaderboard?${board}&page=abc`],
		['GET', `/api/stats/leaderboard?${board}&season=1.5`],
		['GET', '/api/runs/not-a-uuid/replay'],
	]) {
		const token = path.startsWith('/api/runs') ? webJwt(out.honestPlayer, PREFIX + 'mir_1') : adm.token
		const r = await express(method, path, { token, body })
		check(`${method} ${path.split('?')[0]}${path.includes('?') ? '?' + path.split('&').pop() : ''}: 4xx, not 500 (f12644c needs deploy)`, r.status >= 400 && r.status < 500, `${r.status} ${r.text.slice(0, 80)}`)
	}

	// Report resolve on one of this run's throwaway reports.
	if (mine[0]) {
		const resolved = await express('PATCH', `${W}/reports/${mine[0].id}/resolve`, { token: mod.token, body: {} })
		check('reports/:id/resolve', resolved.ok && resolved.body.report && resolved.body.report.id === mine[0].id, resolved.text.slice(0, 160))
		check('reports/:id/resolve unknown: 404', (await express('PATCH', `${W}/reports/999999999/resolve`, { token: mod.token, body: {} })).status === 404)
	}

	// More read-only webadmin routes (no writes).
	for (const path of ['blog/posts', 'launcher-releases', 'archives', 'match-conflicts', 'service-queue']) {
		const r = await express('GET', `${W}/${path}`, { token: mod.token })
		check(`GET ${W}/${path}: 200`, r.ok, r.ok ? '' : `${r.status} ${r.text.slice(0, 120)}`)
	}
	check('archives path traversal: 404', (await express('GET', `${W}/archives/..%2F..%2Fetc%2Fpasswd`, { token: mod.token })).status === 404)
	check('blog/posts/:id bad id: 400', (await express('GET', `${W}/blog/posts/abc`, { token: mod.token })).status === 400)
	// The mod catalog needs the mod_registry migrations (0041/0044/0045); on a
	// DB migrated from another branch's journal they're skipped and this 500s.
	const mods = await express('GET', `${W}/mods`, { token: mod.token })
	console.log(`  info: GET ${W}/mods -> ${mods.status} ${mods.text.slice(0, 80)}`)

	const h = await express('GET', '/health')
	check('/health 200', h.ok, h.text.slice(0, 120))

	for (const s of sockets) s.close()
	await sleep(300)
	process.exitCode = summary('webadmin.live') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
