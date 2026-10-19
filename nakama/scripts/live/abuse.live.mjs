// Live: abuse and security edges against the local Nakama. Forged Steam custom
// ids, custom-id link/unlink, admin RPC keys, a player session calling admin
// RPCs, relay budget/size limits, forged envelope fields, start options and
// replay-log caps, result spoofing, full lobbies, bad codes, a deleted
// account's token, and malformed payloads to every player RPC (checking the
// Nakama log for JS exceptions).
// Run: node nakama/scripts/live/abuse.live.mjs
import {
	HTTP_KEY,
	NAKAMA,
	PREFIX,
	SERVER_KEY,
	ServerOp,
	admin,
	check,
	connect,
	deviceAuth,
	lobbyWith,
	nakamaLogsSince,
	nakamaRest,
	rpc,
	sleep,
	startGame,
	summary,
} from './lib.mjs'

const PLAYER_RPCS = [
	'queue_counts', 'session_init', 'tos_accept', 'profile_set_display', 'profile_set_joker', 'profile_set_mods',
	'mute_set', 'discord_link_start', 'discord_unlink', 'chat_enable', 'chat_send', 'report_submit',
	'launcher_session_start', 'launcher_challenge_answer', 'lobby_create', 'lobby_find', 'spectate_list',
	'lobby_current', 'lobby_leave', 'run_active', 'run_get', 'run_logs', 'runs_mine', 'legacy_ratings_import',
	'rating_get', 'leaderboard_get',
]
const ADMIN_RPCS = [
	'admin_ping', 'admin_notify', 'admin_config_set', 'admin_ban_apply', 'admin_ban_lift', 'admin_lobby_list',
	'admin_lobby_get', 'admin_lobby_kick', 'admin_lobby_close', 'admin_player_get', 'admin_discord_set',
	'admin_integrity_set', 'admin_queue_cancel', 'admin_mirror_pull', 'admin_mirror_ack', 'admin_profile_set',
	'admin_account_delete', 'admin_runs_purge', 'admin_ratings_set',
]

const stamp = Date.now().toString(36)

async function player(name) {
	const p = await deviceAuth(`ab_${stamp}_${name}`)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	return p
}

// A raw RPC body (with unwrap, the body is the payload as sent).
async function rawRpc(token, id, body) {
	const res = await fetch(`${NAKAMA}/v2/rpc/${id}?unwrap`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body,
	})
	return { status: res.status, text: await res.text() }
}

const basic = 'Basic ' + Buffer.from(`${SERVER_KEY}:`).toString('base64')

async function customAuth(id, vars) {
	const res = await fetch(`${NAKAMA}/v2/account/authenticate/custom?create=true`, {
		method: 'POST',
		headers: { authorization: basic, 'content-type': 'application/json' },
		body: JSON.stringify({ id, vars }),
	})
	return { status: res.status, text: await res.text() }
}

async function main() {
	const since = new Date().toISOString()

	// --- forged Steam login ---
	const forged = await customAuth('steam:76561190000000001', {})
	check('custom login without a ticket refused', forged.status >= 400 && /Steam ticket/.test(forged.text), `${forged.status}`)
	const badTicket = await customAuth('steam:76561190000000001', { steam_ticket: 'zz-not-hex' })
	check('custom login with a malformed ticket refused', badTicket.status >= 400, `${badTicket.status}`)
	const fakeTicket = await customAuth('steam:76561190000000001', { steam_ticket: 'deadbeefdeadbeefdeadbeef' })
	check('custom login with a fake hex ticket refused', fakeTicket.status >= 400, `${fakeTicket.status} ${fakeTicket.text.slice(0, 100)}`)

	const a = await player('a')
	const b = await player('b')
	const c = await player('c')
	const link = await nakamaRest('POST', '/v2/account/link/custom', a.token, { id: 'steam:76561190000000001' })
	check('link custom id refused', link.status >= 400 && /only set by Steam/.test(link.text), `${link.status}`)
	const unlink = await nakamaRest('POST', '/v2/account/unlink/custom', a.token, { id: 'steam:76561190000000001' })
	check('unlink custom id refused', unlink.status >= 400, `${unlink.status}`)

	// --- admin RPC keys ---
	const noKey = await admin('admin_ping', {}, null)
	check('admin RPC without a key refused', noKey.status === 401, `${noKey.status}`)
	const wrongKey = await admin('admin_ping', {}, HTTP_KEY + 'x')
	check('admin RPC with a wrong key refused', wrongKey.status === 401, `${wrongKey.status}`)
	const leaked = []
	for (const id of ADMIN_RPCS) {
		const r = await rpc(a.token, id, { userId: a.userId, code: 'ZZZZZZ' })
		if (r.ok) leaked.push(id)
	}
	check('player session refused by every admin RPC', leaked.length === 0, leaked.join(','))

	// --- lobby: full, bad codes ---
	const { code, matchId, sockets } = await lobbyWith([a, b], { maxPlayers: 2 })
	c.socket = await connect(c)
	const full = await c.socket.join(matchId, { modId: PREFIX + 'mod', displayName: c.username })
	check('joining a full lobby refused', !!full.error, JSON.stringify(full.error || full).slice(0, 120))
	for (const bad of ['ZZZZZZ', '', 'a'.repeat(500), '../../x', 123, null]) {
		const r = await rpc(c.token, 'lobby_find', { code: bad })
		check(`lobby_find bad code ${JSON.stringify(bad).slice(0, 12)} refused cleanly`, !r.ok && r.status < 500, `${r.status}`)
	}
	const bogusMatch = await c.socket.join('00000000-0000-0000-0000-000000000000.nakama', {})
	check('joining a nonexistent match id refused', !!bogusMatch.error)

	// --- relay limits (pre-game) ---
	const [sa, sb] = sockets
	const markB = sb.mark()
	sa.sendOp(5, { cid: 'forge1', action: 'h1test_ping', to: '*', from: b.userId, params: { n: 0 } })
	const relayed = await sb.waitFor((i) => i.kind === 'data' && i.op === ServerOp.ACTION && i.data.cid === 'forge1', 4000, markB)
	check('forged envelope "from" replaced by the real sender', relayed && relayed.data.from === a.userId, relayed ? JSON.stringify(relayed.data).slice(0, 160) : 'not relayed')
	const markA = sa.mark()
	for (let i = 0; i < 160; i++) sa.sendOp(5, { cid: `burst${i}`, action: 'h1test_ping', to: '*', params: { i } })
	await sleep(1500)
	const limited = sa.inbox.slice(markA).filter((i) => i.kind === 'data' && i.op === ServerOp.ACTION_REJECTED && i.data.reason === 'rate_limited')
	check('relay burst past budget rate_limited', limited.length >= 20, `${limited.length} of 160 rate_limited`)
	await sleep(3000) // let the bucket refill
	const badKey = await sa.ask('bad key!', {})
	check('bad action key refused', badKey.rejected === 'bad_action', JSON.stringify(badKey))
	const notAuth = await sa.ask('h1test_ping', {})
	check('server-targeted non-authoritative action refused', notAuth.rejected === 'not_authoritative', JSON.stringify(notAuth))
	const logBefore = await sa.ask('mpapi_log_event', { t: 0, opcode: 'x' })
	check('log_event before start refused', logBefore.rejected === 'not_in_game', JSON.stringify(logBefore))

	// --- start options ---
	const nonHost = await sb.ask('mpapi_start_game', { stake: 1 })
	check('non-host start refused', !!nonHost.rejected, JSON.stringify(nonHost))
	await sb.ask('mpapi_ready', { ready: true })
	const started = await startGame([a, b], { stake: 1, options: { ok: true } })
	const runId = started && started.runId
	check('game started', typeof runId === 'string', JSON.stringify(started).slice(0, 160))

	// --- result spoofing ---
	const stranger = await sa.ask('mpapi_report_result', { placements: [{ playerId: a.userId, place: 1 }, { playerId: c.userId, place: 2 }] })
	check('report naming a non-participant refused', !!stranger.rejected, JSON.stringify(stranger))
	const dup = await sa.ask('mpapi_report_result', { placements: [{ playerId: a.userId, place: 1 }, { playerId: a.userId, place: 2 }] })
	check('report with duplicate players refused', !!dup.rejected, JSON.stringify(dup))
	const partial = await sa.ask('mpapi_report_result', { placements: [{ playerId: a.userId, place: 1 }] })
	check('report missing a participant refused', !!partial.rejected, JSON.stringify(partial))
	const junk = await sa.ask('mpapi_report_result', { placements: 'first' })
	check('report with junk placements refused', !!junk.rejected, JSON.stringify(junk))

	// --- log byte cap: ~15KB events, past 1MB they're dropped silently ---
	// (2KB events: Nakama's 4KB socket frame limit drops bigger messages.)
	const pad = 'y'.repeat(2000)
	let refused = 0
	const before = sb.mark()
	for (let i = 0; i < 560; i++) {
		sb.action('mpapi_log_event', { t: i, opcode: 'pad', args: [pad], run: runId })
		if (i % 20 === 19) await sleep(1050)
	}
	await sleep(1500)
	refused = sb.inbox.slice(before).filter((i) => i.kind === 'data' && i.op === ServerOp.ACTION_REJECTED).length
	check('oversize log not refused (silently capped)', refused === 0, `${refused} rejections`)
	const ra = await sa.ask('mpapi_report_result', { placements: [{ playerId: a.userId, place: 1 }, { playerId: b.userId, place: 2 }] })
	const rb = await sb.ask('mpapi_report_result', { placements: [{ playerId: a.userId, place: 1 }, { playerId: b.userId, place: 2 }] })
	check('both report', ra.ok && rb.ok, JSON.stringify([ra, rb]))
	await sleep(1500)
	const logs = await rpc(b.token, 'run_logs', { runId, playerId: b.userId })
	const bl = logs.ok && logs.body.logs && logs.body.logs[b.userId]
	check(
		'stored log truncated at the 1MB cap',
		bl && bl.truncated === true && bl.eventCount >= 480 && bl.eventCount < 560,
		bl ? `eventCount ${bl.eventCount} truncated ${bl.truncated}` : logs.text.slice(0, 160),
	)
	const late = await sa.ask('mpapi_report_result', { placements: [{ playerId: b.userId, place: 1 }, { playerId: a.userId, place: 2 }] })
	check('re-report after the game ended refused', !!late.rejected, JSON.stringify(late))

	// --- run_get / run_logs: outsider ---
	const og = await rpc(c.token, 'run_get', { runId })
	check('run_get by a non-participant refused', og.status === 404, `${og.status} (run_get gate: fix db29b3b needs deploy)`)
	const ol = await rpc(c.token, 'run_logs', { runId })
	check('run_logs by a non-participant refused', ol.status === 404, `${ol.status}`)

	// --- malformed payloads to every player RPC ---
	const bodies = ['{bad', '[]', 'null', '123', '"str"', '{"code":{"$gt":""},"runId":[1],"userId":{},"steamName":[]}']
	const fivehundreds = []
	for (const id of PLAYER_RPCS) {
		for (const body of bodies) {
			const r = await rawRpc(c.token, id, body)
			if (r.status >= 500) fivehundreds.push(`${id} ${body.slice(0, 8)} -> ${r.status} ${r.text.slice(0, 80)}`)
		}
	}
	check('no player RPC answers malformed input with a 5xx', fivehundreds.length === 0, fivehundreds.slice(0, 8).join(' | '))
	// A cursor Nakama never handed out (1928434, needs deploy).
	for (const [id, payload] of [
		['runs_mine', { cursor: 'junk' }],
		['leaderboard_get', { modId: PREFIX + 'mod', mode: PREFIX + 'rk', cursor: 'junk' }],
		['spectate_list', { cursor: 'junk' }],
	]) {
		const r = await rawRpc(c.token, id, JSON.stringify(payload))
		check(`${id} with a junk cursor: no 5xx (1928434 needs deploy)`, r.status < 500, `${r.status} ${r.text.slice(0, 80)}`)
	}

	// --- a deleted account's token ---
	const d = await player('d')
	const del = await admin('admin_account_delete', { userId: d.userId })
	check('throwaway account deleted', del.ok, del.text.slice(0, 120))
	const ds = await connect(d).catch((e) => null)
	// Opening is the known token-revocation limit; refused is stricter. Either is fine.
	console.log(`  info: deleted account's token on a socket -> ${ds ? 'opened (token revocation limit)' : 'refused'}`)
	const e = await player('e')
	const { matchId: ghostMatch, code: ghostCode, sockets: es } = await lobbyWith([e])
	const delToken = await rpc(d.token, 'rating_get', {})
	console.log(`  info: deleted account's token on rating_get -> ${delToken.status} (Nakama token revocation limit)`)
	if (ds) {
		await sleep(1000)
		const dj = ds.closed ? { error: 'socket closed ' + ds.closeCode } : await ds.join(ghostMatch, { modId: PREFIX + 'mod', displayName: 'ghost' })
		check('deleted account cannot join a lobby', !!dj.error, dj.error ? JSON.stringify(dj.error).slice(0, 120) : 'JOINED')
		await sleep(500)
		const view = await admin('admin_lobby_get', { code: ghostCode })
		check('lobby survives the ghost and does not seat it', view.ok && view.body.lobby.players.every((p) => p.id !== d.userId), view.text.slice(0, 160))
		ds.close()
	}
	await rpc(e.token, 'lobby_leave', {})
	es[0].close()

	// --- oversize messages: the server's own limits vs Nakama's socket frame limit ---
	// relay.ts refuses params over 16KB (too_large) and start options over 4KB.
	// socket.max_message_size_bytes (32KB since 6d48a8a; Nakama's default 4096
	// closed the socket with 1009 from ~2.9KB of params) must leave room for
	// both, so a 3KB message is relayed and the bigger ones are refused by
	// relay.ts, all without dropping the socket.
	let szn = 0
	async function oversize(label, send, expectRefusal = true) {
		szn++
		const p = await player(`sz${szn}a`)
		const q2 = await player(`sz${szn}b`)
		const { sockets: ss } = await lobbyWith([p, q2])
		const r = await send(ss[0], ss[1])
		await sleep(500)
		const outcome = expectRefusal ? 'refused' : 'relayed'
		const answered = expectRefusal ? !!r.rejected : !!r.ok
		check(`${label}: ${outcome} without dropping the socket`, answered && !ss[0].closed, `${JSON.stringify(r)} closed=${ss[0].closed} code=${ss[0].closeCode}`)
		for (const s of ss) s.close()
	}
	await oversize('params 3KB (under the 16KB relay cap)', (s) => s.ask('mpapi_ready', { ready: true, pad: 'x'.repeat(3000) }, 3000), false)
	await oversize('params over 16KB', (s) => s.ask('mpapi_ready', { pad: 'x'.repeat(17 * 1024) }, 3000))
	await oversize('start options over 4KB', async (s, s2) => {
		await s2.ask('mpapi_ready', { ready: true })
		return s.ask('mpapi_start_game', { stake: 1, options: { pad: 'x'.repeat(4200) } }, 3000)
	})

	// --- match input burst: messages sent at once, past the budget ---
	// Bad-key actions are refused before the budget (bad_action), so each one
	// sent should come back refused. Nakama's match input queue
	// (match.input_queue_size, 128 by default) drops what overflows before
	// relay.ts sees it ("Match handler data processing too slow, dropping data
	// message"): count how many a burst loses, and that nothing else breaks.
	{
		const p = await player('burst_a')
		const q2 = await player('burst_b')
		const { sockets: bs } = await lobbyWith([p, q2])
		for (const n of [100, 300]) {
			const mark = bs[0].mark()
			for (let i = 0; i < n; i++) bs[0].sendOp(5, { cid: `ib${n}_${i}`, action: 'bad key!', to: 'server', params: null })
			await sleep(4000)
			const answered = bs[0].inbox.slice(mark).filter((i) => i.kind === 'data' && i.op === ServerOp.ACTION_REJECTED && String(i.data.cid).startsWith(`ib${n}_`)).length
			console.log(`  info: input burst of ${n} at once: ${answered} answered, ${n - answered} dropped by Nakama's match input queue`)
			if (n === 100) check('a burst of 100 messages is fully answered', answered === n, `${answered}/${n}`)
		}
		const after = await bs[0].ask('mpapi_ready', { ready: false })
		check('after a 300-message burst the socket is open and the lobby answers', !bs[0].closed && !after.timeout, JSON.stringify(after))
		for (const s of bs) s.close()
	}

	// --- lobby_create spam (limit 30 per player per minute, 514a65e) ---
	{
		const p = await player('spam')
		const statuses = []
		for (let i = 0; i < 35; i++) statuses.push((await rpc(p.token, 'lobby_create', { modId: PREFIX + 'mod' })).status)
		const made = statuses.filter((s) => s === 200).length
		// Nobody joins them: each closes itself after the 30s creator timeout.
		check('lobby_create past 30 a minute refused (514a65e needs deploy)', made === 30 && statuses.slice(30).every((s) => s === 429 || s === 400), `${made} made, then ${statuses.slice(30).join(',')}`)
	}

	// --- exceptions in the Nakama log ---
	await sleep(1000)
	const log = nakamaLogsSince(since)
	check('Nakama log captured for the scan', log.length > 1000, `${log.length} bytes`)
	const errs = log.split('\n').filter((l) => /TypeError|ReferenceError|RangeError|SyntaxError|panic|goja|GoError|Stopping match after error/i.test(l))
	check('no JS exceptions in the Nakama log', errs.length === 0, errs.slice(0, 5).map((l) => l.slice(0, 200)).join('\n'))

	for (const s of [sa, sb, c.socket]) s.close()
	await sleep(300)
	process.exitCode = summary('abuse.live') ? 1 : 0
	process.exit()
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
