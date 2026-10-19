// Live (A0): the Nakama 3.41 party + matchmaker behaviour the group casual
// queue (matchmaking/group/) is built on. A private lobby queues as one
// party ticket the host (party leader) adds, so the design needs:
//   1. Parties: create, join (open party), leave, a full party refusing a
//      join, and only the leader adding a party ticket; every member hears
//      of the ticket (party_matchmaker_ticket).
//   2. A party ticket counts as the party's size: party(2) + solo(1) fill
//      min = max = 3, never min = max = 2; and party(2) at min = max = 2
//      does not match itself alone (so min_count = size + 1 is only a
//      belt-and-braces guard, not what keeps a group from matching itself).
//   3. Every member gets its own MatchmakerMatched, each user entry carrying
//      party_id, and the matched hook's lobby id (match_id) reaches them all.
//   4. A membership change (join, leave, disconnect) drops the party's tickets.
//   5. max_tickets (local.yml: 3) is one budget per session that the
//      party's tickets share: each party ticket counts against every
//      member's session, and a member's solo ticket against the party.
//      Within it Nakama lets a party member hold a solo ticket next to the
//      party's, which matchmaking/gate.ts must refuse.
// With BMP_GROUP_HOOKS=1 (a server running the group-queue module, whose
// before-hooks refuse an unbound party ticket) section 2-3 can't run: it
// checks the refusal instead.
// Casual tickets on the test mod: no rating board, no ranked gate.
// Run: BMP_TEST_PREFIX=a0test_ node nakama/scripts/live/party-semantics.live.mjs
// Clean up: BMP_TEST_PREFIX=a0test_ node nakama/scripts/live/cleanup.live.mjs
import { PREFIX, check, connect, deviceAuth, rpc, sleep, summary } from './lib.mjs'

const MOD = PREFIX + 'mod'
// A fresh mode per run, so leftovers of an aborted run can't match.
const MODE = PREFIX + 'party' + Date.now().toString(36)
const HOOKS = process.env.BMP_GROUP_HOOKS === '1'
// Local matchmaker.interval_sec is 2: three passes.
const PASSES_MS = 6500

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	p.socket = await connect(p)
	return p
}

const props = { modId: MOD, mode: MODE, kind: 'casual' }
const query = `+properties.modId:${MOD} +properties.mode:${MODE} +properties.kind:casual`

const partyOf = (r) => r && r.party
const ticketOf = (r) => r && r.party_matchmaker_ticket && r.party_matchmaker_ticket.ticket
const soloTicketOf = (r) => r && r.matchmaker_ticket && r.matchmaker_ticket.ticket
const other = (key) => (i) => i.kind === 'other' && i.msg && i.msg[key]
const matched = (p, since, ms = PASSES_MS) => p.socket.waitFor((x) => x.kind === 'matched', ms, since)

const create = (p, maxSize) => p.socket.request({ party_create: { open: true, max_size: maxSize } })
const join = (p, partyId) => p.socket.request({ party_join: { party_id: partyId } })
const leave = (p, partyId) => p.socket.request({ party_leave: { party_id: partyId } })
const partyAdd = (p, partyId, min, max, extra = {}) =>
	p.socket.request({
		party_matchmaker_add: { party_id: partyId, min_count: min, max_count: max, query, string_properties: { ...props, ...extra } },
	})
const partyRemove = (p, partyId, ticket) => p.socket.request({ party_matchmaker_remove: { party_id: partyId, ticket } })
const soloAdd = (p, min, max) =>
	p.socket.request({ matchmaker_add: { min_count: min, max_count: max, query, string_properties: props } })
const soloRemove = (p, ticket) => p.socket.request({ matchmaker_remove: { ticket } })

// A party of `members` (the first leads), everyone joined. Returns its id.
async function partyWith(members, maxSize) {
	const created = partyOf(await create(members[0], maxSize))
	if (!created) throw new Error('party_create failed')
	for (const m of members.slice(1)) {
		const since = m.socket.mark()
		const r = await join(m, created.party_id)
		if (r.error) throw new Error('party_join failed: ' + JSON.stringify(r.error))
		await m.socket.waitFor(other('party'), 5000, since)
	}
	return created.party_id
}

async function semantics(a, b, c) {
	// 1. Create, join, the join's presence event, a full party, leader only.
	const createdReply = await create(a, 2)
	const party = partyOf(createdReply)
	check('party_create answers the party (leader = creator)', !!party && party.leader.user_id === a.userId, JSON.stringify(createdReply))
	const pid = party.party_id
	check('party id is "<uuid>.<node>"', /^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/.test(pid), pid)
	const sinceA = a.socket.mark()
	const sinceB = b.socket.mark()
	const joined = await join(b, pid)
	check('party_join of an open party is acked (empty reply)', !joined.error && !joined.timeout, JSON.stringify(joined))
	const bParty = await b.socket.waitFor(other('party'), 5000, sinceB)
	check(
		'the joiner then gets the party, both presences in it',
		!!bParty && bParty.msg.party.presences.length === 2,
		JSON.stringify(bParty && bParty.msg.party.presences.map((p) => p.username)),
	)
	const joinEvent = await a.socket.waitFor(
		(i) => other('party_presence_event')(i) && (i.msg.party_presence_event.joins || []).some((p) => p.user_id === b.userId),
		5000,
		sinceA,
	)
	check('the leader hears the join (party_presence_event joins)', !!joinEvent)
	const full = await join(c, pid)
	check('a full party refuses a join', !!full.error, JSON.stringify(full.error))
	const byMember = await partyAdd(b, pid, 3, 3)
	check('only the leader may add a party ticket', !!byMember.error, JSON.stringify(byMember.error))

	if (HOOKS) {
		const unbound = await partyAdd(a, pid, 3, 3)
		check('group-queue hooks refuse a ticket for a party no lobby queued', !!unbound.error, JSON.stringify(unbound.error))
		const sinceA2 = a.socket.mark()
		await leave(b, pid)
		const left = await a.socket.waitFor(
			(i) => other('party_presence_event')(i) && (i.msg.party_presence_event.leaves || []).some((p) => p.user_id === b.userId),
			5000,
			sinceA2,
		)
		check('party_leave: the leader hears the leave', !!left)
		await leave(a, pid)
		return
	}

	// 2. A party ticket counts as the party's size.
	const sinceB2 = b.socket.mark()
	const sinceA3 = a.socket.mark()
	const lone = await partyAdd(a, pid, 2, 2)
	const loneTicket = ticketOf(lone)
	check('the leader adds a party ticket (min = max = 2)', !!loneTicket, JSON.stringify(lone))
	const heard = await b.socket.waitFor(other('party_matchmaker_ticket'), 5000, sinceB2)
	check(
		'a member hears the party ticket (party_matchmaker_ticket)',
		!!heard && heard.msg.party_matchmaker_ticket.ticket === loneTicket,
		JSON.stringify(heard && heard.msg),
	)
	const self = await matched(a, sinceA3, PASSES_MS)
	check('a party of 2 at min = max = 2 does not match itself alone', self === null, JSON.stringify(self))
	const tooBig = soloTicketOf(await soloAdd(c, 2, 2))
	const none = await matched(c, c.socket.mark(), PASSES_MS)
	check('party(2) + solo(1) do not fill min = max = 2', !!tooBig && none === null, JSON.stringify(none))
	await soloRemove(c, tooBig)
	const removedLone = await partyRemove(a, pid, loneTicket)
	check('party_matchmaker_remove of a live ticket succeeds', !removedLone.error && !removedLone.timeout, JSON.stringify(removedLone))

	// 3. party(2) + solo(1) at min = max = 3: one match, every member told.
	const marks = [a.socket.mark(), b.socket.mark(), c.socket.mark()]
	const pt = ticketOf(await partyAdd(a, pid, 3, 3))
	const ct = soloTicketOf(await soloAdd(c, 3, 3))
	check('party ticket (min = max = 3) and solo ticket queued', !!pt && !!ct)
	const [ma, mb, mc] = await Promise.all([matched(a, marks[0], PASSES_MS * 2), matched(b, marks[1], PASSES_MS * 2), matched(c, marks[2], PASSES_MS * 2)])
	check('every party member and the solo get MatchmakerMatched', !!ma && !!mb && !!mc, JSON.stringify({ a: !!ma, b: !!mb, c: !!mc }))
	if (ma && mb && mc) {
		check('all three carry the party ticket / own ticket', ma.ticket === pt && mb.ticket === pt && mc.ticket === ct, JSON.stringify([ma.ticket, mb.ticket, mc.ticket]))
		check('three users in the match', (ma.users || []).length === 3, String((ma.users || []).length))
		const byUser = {}
		for (const u of ma.users || []) byUser[u.presence.user_id] = u
		check(
			'matched user entries carry party_id for the members only',
			byUser[a.userId] && byUser[a.userId].party_id === pid && byUser[b.userId] && byUser[b.userId].party_id === pid && byUser[c.userId] && !byUser[c.userId].party_id,
			JSON.stringify((ma.users || []).map((u) => ({ u: u.presence.username, party: u.party_id }))),
		)
		check('the matched hook\'s lobby id reaches all three', !!ma.match_id && ma.match_id === mb.match_id && mb.match_id === mc.match_id, JSON.stringify([ma.match_id, mb.match_id, mc.match_id]))
		check('MatchmakerMatched has no token once the hook made a match', !ma.token, String(ma.token))
	}
	const spent = await partyRemove(a, pid, pt)
	check('the party ticket is spent by the match (remove answers an error)', !!spent.error, JSON.stringify(spent))

	// 4. A membership change drops the party's tickets.
	const t4 = ticketOf(await partyAdd(a, pid, 3, 3))
	check('party queued again', !!t4)
	await leave(b, pid)
	await sleep(500)
	const afterLeave = await partyRemove(a, pid, t4)
	check('a member leaving drops the party ticket', !!afterLeave.error, JSON.stringify(afterLeave))
	await join(b, pid)
	await sleep(300)

	// A member's socket dropping is a leave too.
	const t5 = ticketOf(await partyAdd(a, pid, 3, 3))
	b.socket.close()
	await sleep(1000)
	const afterDrop = await partyRemove(a, pid, t5)
	check('a member disconnecting drops the party ticket', !!afterDrop.error, JSON.stringify(afterDrop))
	b.socket = await connect(b)
	await join(b, pid)
	await sleep(300)

	// A join into a party that holds a ticket (room to spare: a 3-party).
	await leave(a, pid)
	const pid3 = await partyWith([a, b], 3)
	const t6 = ticketOf(await partyAdd(a, pid3, 4, 4))
	check('3-seat party queued', !!t6)
	await join(c, pid3)
	await sleep(500)
	const afterJoin = await partyRemove(a, pid3, t6)
	check('a member joining drops the party ticket', !!afterJoin.error, JSON.stringify(afterJoin))
	await leave(c, pid3)
	await sleep(300)

	// 5. max_tickets, and a member's solo ticket next to the party's.
	const many = []
	for (let i = 0; i < 4; i++) many.push(await partyAdd(a, pid3, 4, 4, { slot: String(i) }))
	const accepted = many.filter((r) => ticketOf(r))
	check("max_tickets (3) caps a party's tickets", accepted.length === 3 && !!many[3].error, JSON.stringify(many.map((r) => (ticketOf(r) ? 'ok' : r.error && r.error.message))))
	const overBudget = await soloAdd(b, 4, 4)
	check("the party's 3 tickets use up each member's own budget too", !!overBudget.error, JSON.stringify(overBudget.error || ''))
	await partyRemove(a, pid3, ticketOf(accepted[0]))
	await partyRemove(a, pid3, ticketOf(accepted[1]))
	const solo = await soloAdd(b, 4, 4)
	check('within budget a party member may hold a solo ticket too (the gate must refuse it)', !!soloTicketOf(solo), JSON.stringify(solo.error || ''))
	const twoMore = [await partyAdd(a, pid3, 4, 4, { slot: 'x' }), await partyAdd(a, pid3, 4, 4, { slot: 'y' })]
	check("a member's solo ticket counts against the party's budget", !!ticketOf(twoMore[0]) && !!twoMore[1].error, JSON.stringify(twoMore.map((r) => (ticketOf(r) ? 'ok' : r.error && r.error.message))))
	if (soloTicketOf(solo)) await soloRemove(b, soloTicketOf(solo))
	for (const r of [accepted[2], twoMore[0]]) if (ticketOf(r)) await partyRemove(a, pid3, ticketOf(r))

	// The leader leaving: someone else leads, the party lives on.
	const sinceB3 = b.socket.mark()
	await leave(a, pid3)
	const leader = await b.socket.waitFor(other('party_leader'), 5000, sinceB3)
	check('the leader leaving promotes a member (party_leader)', !!leader && leader.msg.party_leader.presence.user_id === b.userId, JSON.stringify(leader && leader.msg))
	await leave(b, pid3)
}

async function main() {
	const [a, b, c] = [await player('a'), await player('b'), await player('c')]
	try {
		await semantics(a, b, c)
	} finally {
		for (const p of [a, b, c]) p.socket.close()
	}
	process.exitCode = summary('party-semantics') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
