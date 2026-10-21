// Live (coexistence): two gamemode mods on one server must never see each
// other's queues, lobbies, seats or boards. Every step uses two throwaway mod
// ids, MOD_P (stands for PvP) and MOD_S (stands for SPDRN), and a fresh mode
// per run so leftovers of an aborted run can't match.
//   1. Pairing: a and b queue MOD_S casual, c queues MOD_P casual on the same
//      mode with honest queries. Only a+b match; c stays queued.
//   2. Query abuse: a ticket for MOD_P whose query is '*' is refused at
//      matchmaker_add ("The ticket does not match its queue"), so it can't
//      pull in and spend MOD_S tickets. Unfixed: accepted, and the MOD_S
//      tickets it matches with are burned ("Tickets disagree" in the logs).
//   3. Join by code: a MOD_S join of a MOD_P lobby is refused ("Lobby is for
//      a different mod"). A seated member who drops and rejoins with MOD_S is
//      refused too (unfixed: let back in, state.ts member check came first);
//      with MOD_P they are let back in.
//   4. One seat per user across mods: a seated player of a started MOD_P
//      game with the socket closed: lobby_current and run_active name MOD_P,
//      and a MOD_S lobby_create gives ALREADY_EXISTS "Already in lobby
//      <code>" (the message the client turns into the "You still have a seat
//      in a <mod> game: Rejoin / Leave it" prompt).
//   5. Standing is global (user decision: keep as is). With the allowlist
//      pinned to MultiplayerAPI + MultiplayerSPDRN and no extras, a player
//      reporting MultiplayerPvP is refused a MOD_S casual ticket naming
//      MultiplayerPvP; with MultiplayerPvP pinned too, accepted. The config
//      is put back afterwards, whatever happens.
//   6. Boards: a ranked game under MOD_P and one under MOD_S on the same mode
//      string; rating_get per (modId, mode) shows only that mod's game.
//   7. Readiness cancel: admin_queue_cancel without a modId sends
//      QUEUE_CANCELLED (103) with modId null (documented, not a leak: an
//      honest client is only ever queued in one mod).
//   8. lobby_find {code, modId}: another mod's code is refused with
//      FAILED_PRECONDITION "Lobby is for a different mod"; no modId or the
//      right one finds it. Unfixed: found whatever modId.
//   9. Spectate: a spectator join (role=spectator) naming another mod is
//      refused "Lobby is for a different mod"; naming the right mod (or none)
//      is let in. Unfixed: let in whatever modId.
//
// Prerequisites: the local stack (HOWTO.md) running a Nakama module built
// from this branch (`cd nakama && pnpm build && docker restart bmp-nakama`),
// rankedEnabled and casualQueueEnabled on, integrityEnforced off (baseline).
// Steps 2, 3 (member rejoin), 8 and 9 FAIL on a module built without the
// coexistence fixes, which is how to reproduce them.
// Run: BMP_TEST_PREFIX=cxtest_ node nakama/scripts/live/coexist.live.mjs
// Clean up: BMP_TEST_PREFIX=cxtest_ node nakama/scripts/live/cleanup.live.mjs
import {
	BASELINE_REPORT,
	PREFIX,
	ServerOp,
	admin,
	check,
	connect,
	deviceAuth,
	lobbyWith,
	psql,
	q,
	rpc,
	sendLog,
	serverConfig,
	sleep,
	startGame,
	summary,
} from './lib.mjs'
import { hostFirst } from './mirror.live.mjs'

const MOD_P = PREFIX + 'pvp'
const MOD_S = PREFIX + 'spd'
const MODE = PREFIX + 'm' + Date.now().toString(36)
const MATCH_MS = 12000
const NO_MATCH_MS = 8000
const ALREADY_EXISTS = 6
const FAILED_PRECONDITION = 9

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	await rpc(p.token, 'profile_set_mods', { mods: BASELINE_REPORT })
	p.socket = await connect(p)
	return p
}

async function reconnect(p) {
	p.socket.close()
	await sleep(500)
	p.socket = await connect(p)
	return p.socket
}

const honestQuery = (modId, mode, kind) => `+properties.modId:${modId} +properties.mode:${mode} +properties.kind:${kind}`
const add = (p, modId, { mode = MODE, kind = 'casual', count = 2, query } = {}) =>
	p.socket.request({
		matchmaker_add: {
			min_count: count,
			max_count: count,
			query: query === undefined ? honestQuery(modId, mode, kind) : query,
			string_properties: { modId, mode, kind },
		},
	})
const ticketOf = (t) => t && t.matchmaker_ticket && t.matchmaker_ticket.ticket
const errorOf = (t) => (t && t.error && t.error.message) || ''
const removeTicket = (p, t) => (ticketOf(t) ? p.socket.request({ matchmaker_remove: { ticket: ticketOf(t) } }) : null)
const matched = (since) => (p) => p.socket.waitFor((i) => i.kind === 'matched', MATCH_MS, since)
const leaveMatch = (p) => p.socket.sendOp(1, {})

async function pairing(a, b, c) {
	const marks = [a, b, c].map((p) => p.socket.mark())
	const tc = await add(c, MOD_P)
	const ta = await add(a, MOD_S)
	const tb = await add(b, MOD_S)
	check('1. honest MOD_S and MOD_P tickets are accepted', ticketOf(ta) && ticketOf(tb) && ticketOf(tc), JSON.stringify([ta, tb, tc]).slice(0, 300))
	const [ma, mb] = await Promise.all([matched(marks[0])(a), matched(marks[1])(b)])
	check('1. the two MOD_S tickets match each other', ma && mb && ma.match_id && ma.match_id === mb.match_id, JSON.stringify([ma, mb]).slice(0, 300))
	const mc = await c.socket.waitFor((i) => i.kind === 'matched', NO_MATCH_MS, marks[2])
	check('1. the MOD_P ticket on the same mode stays queued', !mc, JSON.stringify(mc).slice(0, 200))
	await removeTicket(c, tc)
}

async function queryAbuse(a, b, c) {
	const marks = [a, b].map((p) => p.socket.mark())
	const ta = await add(a, MOD_S)
	const tb = await add(b, MOD_S, { count: 3 })
	const wide = await add(c, MOD_P, { query: '*', count: 2 })
	check(
		"2. a MOD_P ticket with query '*' is refused at matchmaker_add",
		!ticketOf(wide) && /does not match its queue/.test(errorOf(wide)),
		JSON.stringify(wide).slice(0, 200),
	)
	const pvpQueryForSpd = await add(c, MOD_S, { query: honestQuery(MOD_P, MODE, 'casual') })
	check(
		"2. a ticket whose query pins another mod than its properties is refused",
		!ticketOf(pvpQueryForSpd) && /does not match its queue/.test(errorOf(pvpQueryForSpd)),
		JSON.stringify(pvpQueryForSpd).slice(0, 200),
	)
	const burned = await Promise.all([a, b].map((p, i) => p.socket.waitFor((x) => x.kind === 'matched', NO_MATCH_MS, marks[i])))
	check('2. the queued MOD_S tickets are not pulled into a match', burned.every((m) => !m), JSON.stringify(burned).slice(0, 200))
	await removeTicket(a, ta)
	await removeTicket(b, tb)
	await removeTicket(c, wide)
	await removeTicket(c, pvpQueryForSpd)
}

async function joinByCode(h, j) {
	const lobby = await lobbyWith([h], { modId: MOD_P })
	const wrong = await j.socket.join(lobby.matchId, { modId: MOD_S, displayName: j.username })
	check('3. a MOD_S join of a MOD_P lobby is refused', /different mod/.test(errorOf(wrong)), JSON.stringify(wrong).slice(0, 200))
	const right = await j.socket.join(lobby.matchId, { modId: MOD_P, displayName: j.username })
	check('3. a MOD_P join is accepted', !right.error, JSON.stringify(right).slice(0, 200))
	await j.socket.waitFor((i) => i.kind === 'data' && i.op === ServerOp.SNAPSHOT, 5000)

	const s = await reconnect(j)
	const rejoinWrong = await s.join(lobby.matchId, { modId: MOD_S, displayName: j.username })
	check(
		'3. a seated member rejoining with MOD_S is refused (member check after mod check)',
		/different mod/.test(errorOf(rejoinWrong)),
		JSON.stringify(rejoinWrong).slice(0, 200),
	)
	const rejoinRight = await s.join(lobby.matchId, { modId: MOD_P, displayName: j.username })
	check('3. the member rejoining with MOD_P is let back in', !rejoinRight.error, JSON.stringify(rejoinRight).slice(0, 200))
	for (const p of [h, j]) leaveMatch(p)
	await sleep(700)
	return lobby.code
}

async function seatAcrossMods(a, b) {
	const lobby = await lobbyWith([a, b], { modId: MOD_P })
	await startGame(await hostFirst(lobby.code, [a, b]), {})
	a.socket.close()
	await sleep(1000)
	const current = (await rpc(a.token, 'lobby_current', {})).body
	check(
		'4. lobby_current names the MOD_P seat',
		current && current.code === lobby.code && current.modId === MOD_P && current.matchId === lobby.matchId,
		JSON.stringify(current),
	)
	const active = (await rpc(a.token, 'run_active', {})).body
	check('4. run_active names MOD_P', active && active.active && active.active.modId === MOD_P, JSON.stringify(active).slice(0, 300))
	const create = await rpc(a.token, 'lobby_create', { modId: MOD_S })
	check(
		'4. a MOD_S lobby_create gives ALREADY_EXISTS "Already in lobby <code>"',
		!create.ok && create.body && create.body.code === ALREADY_EXISTS && create.text.indexOf(`Already in lobby ${lobby.code}`) !== -1,
		create.text.slice(0, 200),
	)
	const left = await rpc(a.token, 'lobby_leave', {})
	check('4. lobby_leave gives the seat up', left.ok, left.text.slice(0, 200))
	const after = (await rpc(a.token, 'lobby_current', {})).body
	check('4. no seat after lobby_leave', after && !after.matchId, JSON.stringify(after))
	a.socket = await connect(a)
	leaveMatch(b)
	await sleep(700)
}

async function standingIsGlobal(u) {
	const before = serverConfig()
	const original = {
		queueAllowedModIds: before.queueAllowedModIds || [],
		queueAllowedModIdsExtra: before.queueAllowedModIdsExtra || [],
	}
	try {
		await admin('admin_config_set', { queueAllowedModIds: ['MultiplayerAPI', 'MultiplayerSPDRN'], queueAllowedModIdsExtra: [] })
		await rpc(u.token, 'profile_set_mods', {
			mods: [...BASELINE_REPORT, 'MultiplayerAPI-0.1.0', 'MultiplayerSPDRN-0.1.0', 'MultiplayerPvP-0.1.0'],
		})
		const refused = await add(u, MOD_S)
		check(
			'5. (H1, kept global) an unpinned MultiplayerPvP refuses a MOD_S casual ticket, naming it',
			!ticketOf(refused) && /MultiplayerPvP/.test(errorOf(refused)),
			JSON.stringify(refused).slice(0, 200),
		)
		await removeTicket(u, refused)
		await admin('admin_config_set', { queueAllowedModIds: ['MultiplayerAPI', 'MultiplayerSPDRN', 'MultiplayerPvP'] })
		const accepted = await add(u, MOD_S)
		check('5. with MultiplayerPvP pinned too, the ticket is accepted', ticketOf(accepted), JSON.stringify(accepted).slice(0, 200))
		await removeTicket(u, accepted)
	} finally {
		await admin('admin_config_set', original)
		await rpc(u.token, 'profile_set_mods', { mods: BASELINE_REPORT })
	}
	const restored = serverConfig()
	check(
		'5. the allowlist is put back',
		JSON.stringify(restored.queueAllowedModIds || []) === JSON.stringify(original.queueAllowedModIds) &&
			JSON.stringify(restored.queueAllowedModIdsExtra || []) === JSON.stringify(original.queueAllowedModIdsExtra),
		JSON.stringify(restored),
	)
}

async function rankedGame(modId, [w, l]) {
	const marks = [w, l].map((p) => p.socket.mark())
	for (const p of [w, l]) {
		const t = await add(p, modId, { kind: 'ranked' })
		if (!ticketOf(t)) throw new Error('ranked matchmaker_add: ' + JSON.stringify(t))
	}
	const found = await Promise.all([w, l].map((p, i) => matched(marks[i])(p)))
	if (!found[0]) throw new Error('ranked tickets did not match')
	const matchId = found[0].match_id
	for (const p of [w, l]) {
		const j = await p.socket.join(matchId, { modId, displayName: p.username })
		if (j.error) throw new Error('ranked join: ' + JSON.stringify(j.error))
		await p.socket.waitFor((x) => x.kind === 'data' && x.op === ServerOp.SNAPSHOT, 5000)
	}
	const code = psql('nakama', `select key from storage where collection='lobby_codes' and value->>'matchId'=${q(matchId)}`)[0][0]
	const ordered = await hostFirst(code, [w, l])
	const { runId } = await startGame(ordered, {})
	for (const p of [w, l]) await sendLog(p.socket, runId, [[1, 'start', { deck: 'b_red' }], [2, 'end', {}]])
	await sleep(300)
	const since = w.socket.mark()
	for (const p of [w, l])
		await p.socket.ask('mpapi_report_result', { placements: [{ playerId: w.userId, place: 1 }, { playerId: l.userId, place: 2 }] })
	await w.socket.waitFor((x) => x.kind === 'data' && x.op === ServerOp.EVENT && x.data.type === 'game_ended', 15000, since)
	for (const p of [w, l]) leaveMatch(p)
	await sleep(700)
}

async function boards(a, b, c, d) {
	await rankedGame(MOD_P, [a, b])
	await rankedGame(MOD_S, [c, d])
	const games = async (p, modId) => ((await rpc(p.token, 'rating_get', { modId, mode: MODE })).body || {}).gamesPlayed
	check('6. MOD_P players have one MOD_P game and none on MOD_S', (await games(a, MOD_P)) === 1 && (await games(a, MOD_S)) === 0)
	check('6. MOD_S players have one MOD_S game and none on MOD_P', (await games(c, MOD_S)) === 1 && (await games(c, MOD_P)) === 0)
}

async function readinessCancel(u) {
	const since = u.socket.mark()
	const r = await admin('admin_queue_cancel', { userId: u.userId, reason: 'mods_outdated' })
	check('7. admin_queue_cancel accepted', r.ok, r.text.slice(0, 200))
	const n = await u.socket.waitFor((i) => i.kind === 'notification' && i.code === 103, 5000, since)
	check('7. QUEUE_CANCELLED carries modId null (documented; one mod queued at a time)', n && n.content.modId === null, JSON.stringify(n && n.content))
}

async function findByMod(h) {
	const lobby = await lobbyWith([h], { modId: MOD_P })
	const plain = await rpc(h.token, 'lobby_find', { code: lobby.code })
	check('8. lobby_find without modId finds it', plain.ok && plain.body.modId === MOD_P, plain.text.slice(0, 200))
	const right = await rpc(h.token, 'lobby_find', { code: lobby.code, modId: MOD_P })
	check('8. lobby_find with its own modId finds it', right.ok && right.body.matchId === lobby.matchId, right.text.slice(0, 200))
	const wrong = await rpc(h.token, 'lobby_find', { code: lobby.code, modId: MOD_S })
	check(
		'8. lobby_find with another modId is refused FAILED_PRECONDITION "Lobby is for a different mod"',
		!wrong.ok && wrong.body && wrong.body.code === FAILED_PRECONDITION && /different mod/.test(wrong.text),
		wrong.text.slice(0, 200),
	)
	leaveMatch(h)
	await sleep(700)
}

async function spectateByMod(a, b, s) {
	const lobby = await lobbyWith([a, b], { modId: MOD_P })
	a.socket.sendOp(3, { metadata: { spectatable: true } })
	await sleep(500)
	const wrong = await s.socket.join(lobby.matchId, { role: 'spectator', modId: MOD_S })
	check('9. a MOD_S spectator of a MOD_P lobby is refused', /different mod/.test(errorOf(wrong)), JSON.stringify(wrong).slice(0, 200))
	const right = await s.socket.join(lobby.matchId, { role: 'spectator', modId: MOD_P })
	check('9. a MOD_P spectator is let in', !right.error, JSON.stringify(right).slice(0, 200))
	leaveMatch(s)
	await sleep(500)
	const s2 = await reconnect(s)
	const none = await s2.join(lobby.matchId, { role: 'spectator' })
	check('9. a spectator naming no mod is let in (older clients)', !none.error, JSON.stringify(none).slice(0, 200))
	for (const p of [a, b, s]) leaveMatch(p)
	await sleep(700)
}

async function main() {
	const [a, b, c, d, e] = [await player('a'), await player('b'), await player('c'), await player('d'), await player('e')]
	await pairing(a, b, c)
	await sleep(1000)
	await queryAbuse(a, b, c)
	await joinByCode(d, e)
	await seatAcrossMods(a, b)
	await standingIsGlobal(e)
	await boards(a, b, c, d)
	await readinessCancel(e)
	await findByMod(c)
	await spectateByMod(a, b, e)
	for (const p of [a, b, c, d, e]) p.socket.close()
	await sleep(300)
	process.exitCode = summary('coexist') ? 1 : 0
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})
