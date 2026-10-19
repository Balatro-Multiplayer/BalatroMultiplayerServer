// Live (A1/A2): the group casual queue (matchmaking/group/) end to end on a
// server running the group-queue module.
//   1. Two players in a private lobby queue as one party and meet a solo
//      player in one public match; the home lobby keeps its code and host
//      while they are away, and they rejoin it afterwards (all_returned, or
//      away_over once the public lobby is done).
//   2. While the group queues, a member's own solo ticket is refused.
//   3. A member leaving the party, or the lobby, cancels the group queue.
//   4. Ranked is refused; so is a non-host opening, and a stranger joining
//      the bound party.
// Casual tickets on the test mod: no rating board, no ranked gate.
// Run: BMP_TEST_PREFIX=gqtest_ node nakama/scripts/live/group-queue.live.mjs
// Clean up: BMP_TEST_PREFIX=gqtest_ node nakama/scripts/live/cleanup.live.mjs
import { ClientOp, PREFIX, ServerOp, check, connect, deviceAuth, lobbyWith, rpc, sleep, summary } from './lib.mjs'

const MOD = PREFIX + 'mod'
// A fresh mode per run, so leftovers of an aborted run can't match.
const MODE = PREFIX + 'grp' + Date.now().toString(36)
// Local matchmaker.interval_sec is 2: a few passes.
const MATCH_MS = 12000

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	p.socket = await connect(p)
	return p
}

const props = (mode) => ({ modId: MOD, mode, kind: 'casual' })
const query = (mode) => `+properties.modId:${MOD} +properties.mode:${mode} +properties.kind:casual`
const other = (key) => (i) => i.kind === 'other' && i.msg && i.msg[key]
const groupOp = (pred = () => true) => (i) => i.kind === 'data' && i.op === ServerOp.GROUP_QUEUE && pred(i.data)
const snapshot = (matchId) => (i) => i.kind === 'data' && i.op === ServerOp.SNAPSHOT && i.matchId === matchId

const partyCreate = (p) => p.socket.request({ party_create: { open: true, max_size: 8 } })
const partyJoin = (p, partyId) => p.socket.request({ party_join: { party_id: partyId } })
const partyLeave = (p, partyId) => p.socket.request({ party_leave: { party_id: partyId } })
const partyAdd = (p, partyId, size, mode, { min = size + 1, max = size + 1 } = {}) =>
	p.socket.request({
		party_matchmaker_add: {
			party_id: partyId,
			min_count: min,
			max_count: max,
			query: query(mode),
			string_properties: props(mode),
			numeric_properties: { groupSize: size },
		},
	})
const soloAdd = (p, count, mode) =>
	p.socket.request({
		matchmaker_add: { min_count: count, max_count: count, query: query(mode), string_properties: props(mode) },
	})
const open = (p, partyId, mode, extra = {}) => rpc(p.token, 'group_queue_open', { partyId, mode, ...extra })

// A private lobby of `members` (the first hosting), its group queue open on
// the host's new party and every member in the party. Returns {lobby, partyId}.
async function formedGroup(members, mode) {
	const lobby = await lobbyWith(members, { modId: MOD })
	const host = members[0]
	const created = await partyCreate(host)
	const partyId = created.party && created.party.party_id
	if (!partyId) throw new Error('party_create failed: ' + JSON.stringify(created))
	const since = members.map((m) => m.socket.mark())
	const opened = await open(host, partyId, mode)
	if (!opened.ok || !opened.body.groupQueue) throw new Error('group_queue_open failed: ' + opened.text)
	for (const [i, m] of members.entries()) {
		await m.socket.waitFor(groupOp((d) => d.phase === 'forming'), 5000, since[i])
		if (m === host) continue
		const joined = await partyJoin(m, partyId)
		if (joined.error) throw new Error(`${m.username} party_join failed: ${JSON.stringify(joined.error)}`)
	}
	return { lobby, partyId, opened: opened.body.groupQueue }
}

async function meetInPublic(a, b, s) {
	const mode = MODE + 'm'
	const { lobby, partyId, opened } = await formedGroup([a, b], mode)
	check('group_queue_open forms the whole lobby as the group', opened.phase === 'forming' && opened.memberIds.length === 2)
	check('the open names the home lobby', opened.homeCode === lobby.code && opened.hostId === a.userId, JSON.stringify(opened))

	// 2. Queued: a member's solo ticket is refused.
	const queuedSince = [a, b].map((p) => p.socket.mark())
	const added = await partyAdd(a, partyId, 2, mode)
	check('the host queues the party ticket', !!added.party_matchmaker_ticket, JSON.stringify(added))
	const queued = await b.socket.waitFor(groupOp((d) => d.phase === 'queued'), 5000, queuedSince[1])
	check('every member hears the group is queued (op 112 queued)', !!queued && queued.data.ticket === added.party_matchmaker_ticket.ticket)
	const solo = await soloAdd(b, 3, mode)
	check("a member's own solo ticket is refused while the group queues", !!solo.error, JSON.stringify(solo))

	// 1. The group meets a solo player.
	const since = [a, b, s].map((p) => p.socket.mark())
	const soloTicket = await soloAdd(s, 3, mode)
	check('the solo player queues', !!soloTicket.matchmaker_ticket, JSON.stringify(soloTicket))
	const found = await Promise.all([a, b, s].map((p, i) => p.socket.waitFor((x) => x.kind === 'matched', MATCH_MS, since[i])))
	check('all three are matched', found.every(Boolean))
	if (!found.every(Boolean)) return
	const ids = new Set(found.map((m) => m.match_id))
	check('into one public match', ids.size === 1 && !!found[0].match_id, [...ids].join(','))
	const away = await a.socket.waitFor(groupOp((d) => d.phase === 'away'), 5000, since[0])
	check('the home says the group is away, naming the public lobby', !!away && away.data.matchId === found[0].match_id && !!away.data.code, JSON.stringify(away && away.data))

	// Into the public match: out of the home's socket (the seat stays), in.
	const publicId = found[0].match_id
	for (const p of [a, b]) await p.socket.request({ match_leave: { match_id: lobby.matchId } })
	// One at a time, so the last one's snapshot seats everyone.
	const joins = []
	for (const p of [a, b, s]) {
		const at = p.socket.mark()
		const r = await p.socket.join(publicId, { modId: MOD, displayName: p.username })
		joins.push({ r, snap: await p.socket.waitFor(snapshot(publicId), 5000, at) })
	}
	check('all three join the public lobby', joins.every((j) => !j.r.error && j.snap), JSON.stringify(joins.map((j) => j.r.error)))
	const pub = joins[2].snap && joins[2].snap.data
	check('the public lobby seats all three', !!pub && pub.players.length === 3 && pub.type === 'public', pub && pub.type)

	// The home is held: same code, same host, members away.
	const home = await rpc(s.token, 'lobby_find', { code: lobby.code })
	check('the home code still finds the home lobby', home.ok && home.body.matchId === lobby.matchId, home.text)

	// Back home: leave the public lobby, then rejoin the home by its code.
	for (const p of [a, b]) p.socket.sendOp(ClientOp.LEAVE, {}, publicId)
	await sleep(500)
	const backSince = a.socket.mark()
	const rejoins = []
	for (const p of [a, b]) {
		const at = p.socket.mark()
		const found = await rpc(p.token, 'lobby_find', { code: away.data.homeCode })
		const r = await p.socket.join(found.body.matchId, { modId: MOD, displayName: p.username })
		const snap = await p.socket.waitFor(snapshot(found.body.matchId), 5000, at)
		rejoins.push({ r, snap })
	}
	check('both members rejoin home', rejoins.every((j) => !j.r.error && j.snap), JSON.stringify(rejoins.map((j) => j.r.error)))
	const last = rejoins[1].snap && rejoins[1].snap.data
	check('home keeps its code and host', !!last && last.code === lobby.code && last.hostId === a.userId, JSON.stringify(last && { code: last.code, host: last.hostId }))
	const ended = await a.socket.waitFor(groupOp((d) => d.phase === 'idle'), 5000, backSince)
	check('the group queue ends once everyone is back (all_returned)', !!ended && ended.data.reason === 'all_returned', JSON.stringify(ended && ended.data))
	// Unbound again, so no hook stands in the way: Nakama itself says the
	// party is gone.
	const gone = await partyJoin(s, partyId)
	check('the party is gone', !!gone.error && /not found/i.test(gone.error.message), JSON.stringify(gone))
	const current = await rpc(b.token, 'lobby_current', {})
	check("a member's current lobby is home again", current.ok && current.body.code === lobby.code, current.text)
	for (const p of [a, b]) p.socket.sendOp(ClientOp.LEAVE, {}, lobby.matchId)
	s.socket.sendOp(ClientOp.LEAVE, {}, publicId)
}

async function cancels(c, d) {
	// 3a. A member leaving the party.
	const mode = MODE + 'c'
	const first = await formedGroup([c, d], mode)
	await partyAdd(c, first.partyId, 2, mode)
	await c.socket.waitFor(groupOp((x) => x.phase === 'queued'), 5000)
	let since = c.socket.mark()
	await partyLeave(d, first.partyId)
	let ended = await c.socket.waitFor(groupOp((x) => x.phase === 'idle'), 5000, since)
	check('a member leaving the party cancels the group queue', !!ended && ended.data.reason === 'member_left_party', JSON.stringify(ended && ended.data))
	const solo = await soloAdd(d, 3, mode)
	check('the member may queue solo again afterwards', !!solo.matchmaker_ticket, JSON.stringify(solo))
	if (solo.matchmaker_ticket) await d.socket.request({ matchmaker_remove: { ticket: solo.matchmaker_ticket.ticket } })

	// 3b. A member leaving the lobby (same lobby, new party).
	const created = await partyCreate(c)
	const partyId = created.party.party_id
	since = c.socket.mark()
	const reopened = await open(c, partyId, mode)
	check('the lobby can queue again', reopened.ok && !!reopened.body.groupQueue, reopened.text)
	await partyJoin(d, partyId)
	await partyAdd(c, partyId, 2, mode)
	await c.socket.waitFor(groupOp((x) => x.phase === 'queued'), 5000, since)
	since = c.socket.mark()
	d.socket.sendOp(ClientOp.LEAVE, {}, first.lobby.matchId)
	ended = await c.socket.waitFor(groupOp((x) => x.phase === 'idle'), 5000, since)
	check('a member leaving the lobby cancels the group queue', !!ended && ended.data.reason === 'member_left', JSON.stringify(ended && ended.data))
	c.socket.sendOp(ClientOp.LEAVE, {}, first.lobby.matchId)
}

// 1b. The public lobby closing (everyone left it, as after its game) sends
// the group home: the home's group queue ends with away_over.
async function awayOverOnClose(c, d, g) {
	const mode = MODE + 'o'
	const { lobby, partyId } = await formedGroup([c, d], mode)
	await partyAdd(c, partyId, 2, mode)
	await c.socket.waitFor(groupOp((x) => x.phase === 'queued'), 5000)
	const since = [c, d, g].map((p) => p.socket.mark())
	await soloAdd(g, 3, mode)
	const found = await Promise.all([c, d, g].map((p, i) => p.socket.waitFor((x) => x.kind === 'matched', MATCH_MS, since[i])))
	check('a second group is matched', found.every(Boolean))
	if (!found.every(Boolean)) return
	const publicId = found[0].match_id
	for (const p of [c, d]) await p.socket.request({ match_leave: { match_id: lobby.matchId } })
	for (const p of [c, d, g]) await p.socket.join(publicId, { modId: MOD, displayName: p.username })
	const at = c.socket.mark()
	for (const p of [c, d, g]) p.socket.sendOp(ClientOp.LEAVE, {}, publicId)
	await sleep(500)
	const found2 = await rpc(c.token, 'lobby_find', { code: lobby.code })
	const r = await c.socket.join(found2.body.matchId, { modId: MOD, displayName: c.username })
	// c was out of the home when it heard, so c sees it in the snapshot: no
	// group queue, though d is still away (all_returned can't be why).
	const snap = await c.socket.waitFor(snapshot(found2.body.matchId), 5000, at)
	check('the host rejoins its home after', !r.error && !!snap && snap.data.hostId === c.userId && snap.data.code === lobby.code)
	const dSeat = snap && snap.data.players.filter((p) => p.id === d.userId)[0]
	check(
		'the public lobby closing ends the away group (away_over)',
		!!snap && snap.data.groupQueue === null && !!dSeat && dSeat.isAway,
		JSON.stringify(snap && { groupQueue: snap.data.groupQueue, d: dSeat }),
	)
	c.socket.sendOp(ClientOp.LEAVE, {}, lobby.matchId)
}

async function refusals(e, f, g) {
	const mode = MODE + 'r'
	const lobby = await lobbyWith([e, f], { modId: MOD })
	const created = await partyCreate(e)
	const partyId = created.party.party_id
	const ranked = await open(e, partyId, mode, { kind: 'ranked' })
	check('ranked is refused', ranked.ok && ranked.body.refused && ranked.body.refused.code === 'ranked', ranked.text)
	const notHost = await open(f, partyId, mode)
	check('a non-host may not open', notHost.ok && notHost.body.refused && notHost.body.refused.code === 'not_host', notHost.text)
	const opened = await open(e, partyId, mode)
	check('the host may', opened.ok && !!opened.body.groupQueue, opened.text)
	const stranger = await partyJoin(g, partyId)
	check('a stranger may not join the bound party', !!stranger.error, JSON.stringify(stranger))
	const again = await open(e, partyId, mode)
	check('a second open is refused', again.ok && again.body.refused && again.body.refused.code === 'already_queued', again.text)
	const cancelled = await rpc(f.token, 'group_queue_cancel', {})
	check('any member may cancel', cancelled.ok && cancelled.body.groupQueue === null, cancelled.text)
	for (const p of [e, f]) p.socket.sendOp(ClientOp.LEAVE, {}, lobby.matchId)
}

async function main() {
	const names = ['a', 'b', 's', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
	const players = await Promise.all(names.map((n) => player('gq_' + n)))
	const [a, b, s, c, d, e, f, g, h, i, j] = players
	try {
		await meetInPublic(a, b, s)
		await cancels(c, d)
		await awayOverOnClose(h, i, j)
		await refusals(e, f, g)
	} finally {
		for (const p of players) p.socket.close()
	}
	process.exit(summary('group-queue') === 0 ? 0 : 1)
}

main().catch((e) => {
	console.error(e)
	process.exit(2)
})
