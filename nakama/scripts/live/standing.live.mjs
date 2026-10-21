// Live (valid standing): the mod report, the standing it gives, and where
// matchmaking checks it (standing/, matchmaking/gate.ts, lobby/match.ts).
// The check is always on (there is no switch). The run empties
// queueAllowedModIdsExtra and puts back the boot-seeded value after
// (QUEUE_ALLOWED_MOD_IDS_EXTRA in nakama/local.yml: MultiplayerPvP and
// ClaudeControl).
//   1. Unreported -> none; a report of allowed mods -> valid; one with mods
//      outside the allowlist -> none, naming them.
//   2. Casual: valid may queue, none may not (the refusal names the mods).
//   3. Ranked: with integrityEnforced an unverified valid player is refused;
//      a dev-verified one may queue whatever its mods. Without it the mod
//      check applies to ranked too.
//   4. Private lobbies are never gated.
//   5. A group: the open is refused naming the member and their mods; an
//      unreported player may not join the bound party.
//   6. A matchmade game: run_active says the requiredStanding; a returning
//      player with other mods is refused (the seat stays), and gets back in
//      after a fresh report.
//   7. An allowlist change: STANDING_CHANGED (108) to online reporters, a
//      queued group cancelled naming the refused member (op 112 idle), a
//      queued solo told why (103 with code and mods).
//   8. With the seeded Extra back, the stock dev client (PvP + ClaudeControl
//      included) is valid and may queue casual.
// The allowlist's pinned ids come from Express (mod_registry.smods_ids); the
// run expects MultiplayerAPI and MultiplayerSPDRN among them, and uses Extra
// for ClaudeControl.
// Run: BMP_TEST_PREFIX=sttest_ node nakama/scripts/live/standing.live.mjs
// Clean up: BMP_TEST_PREFIX=sttest_ node nakama/scripts/live/cleanup.live.mjs
import { ClientOp, PREFIX, ServerOp, admin, check, connect, deviceAuth, lobbyWith, rpc, serverConfig, sleep, startGame, summary } from './lib.mjs'

const MOD = PREFIX + 'mod'
// A fresh mode per run, so leftovers of an aborted run can't match.
const MODE = PREFIX + 'std' + Date.now().toString(36)
const MATCH_MS = 12000

// What the stock dev client reports (MPAPI.collect_installed_mods), minus
// ClaudeControl, which is added where a test needs it.
const STOCK = ['Steamodded-1.0.0~BETA-1814a', 'Lovely-0.9.0', 'MultiplayerAPI-1.0.0', 'MultiplayerSPDRN-0.1.1']
const CRYPTID = [...STOCK, 'Cryptid-0.5.3~dev']
const WITH_CC = [...STOCK, 'ClaudeControl-1.0.0']
const DEV_CLIENT = [...STOCK, 'MultiplayerPvP-0.1.0', 'ClaudeControl-1.0.0']
const SEEDED_EXTRA = ['MultiplayerPvP', 'ClaudeControl']

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	p.socket = await connect(p)
	return p
}

const report = (p, mods) => rpc(p.token, 'profile_set_mods', { mods })
const standing = async (p) => (await rpc(p.token, 'account_standing', {})).body
const config = (patch) => admin('admin_config_set', patch)

const props = (mode, kind) => ({ modId: MOD, mode, kind })
const query = (mode, kind) => `+properties.modId:${MOD} +properties.mode:${mode} +properties.kind:${kind}`
const soloAdd = (p, count, mode, kind = 'casual') =>
	p.socket.request({
		matchmaker_add: { min_count: count, max_count: count, query: query(mode, kind), string_properties: props(mode, kind) },
	})
const ticketOf = (t) => t && t.matchmaker_ticket && t.matchmaker_ticket.ticket
const removeTicket = (p, t) => p.socket.request({ matchmaker_remove: { ticket: ticketOf(t) } })
const errorOf = (t) => (t && t.error && t.error.message) || ''

const notification = (code) => (i) => i.kind === 'notification' && i.code === code
const groupOp = (pred = () => true) => (i) => i.kind === 'data' && i.op === ServerOp.GROUP_QUEUE && pred(i.data)
const snapshot = (matchId) => (i) => i.kind === 'data' && i.op === ServerOp.SNAPSHOT && i.matchId === matchId

const partyCreate = (p) => p.socket.request({ party_create: { open: true, max_size: 8 } })
const partyJoin = (p, partyId) => p.socket.request({ party_join: { party_id: partyId } })

async function standings(u) {
	await rpc(u.token, 'session_init', { steamName: u.username })
	const fresh = await standing(u)
	check('unreported -> none (reason unreported)', fresh.standing === 'none' && fresh.reason === 'unreported', JSON.stringify(fresh))
	check('the standing reply has no enforced field (always on)', !('enforced' in fresh), JSON.stringify(fresh))
	const allowed = await report(u, STOCK)
	check(
		'a report of allowed mods -> valid, in the profile_set_mods reply',
		allowed.ok && allowed.body.standing.standing === 'valid' && allowed.body.standing.disallowed.length === 0,
		allowed.text,
	)
	const bad = await report(u, [...CRYPTID, 'ClaudeControl-1.0.0'])
	check(
		'a report with other mods -> none, naming them in report order',
		bad.ok &&
			bad.body.standing.standing === 'none' &&
			bad.body.standing.reason === 'mods_not_allowed' &&
			JSON.stringify(bad.body.standing.disallowed) === JSON.stringify(['Cryptid', 'ClaudeControl']),
		bad.text,
	)
	const asked = await standing(u)
	check('account_standing agrees', asked.standing === 'none' && asked.disallowed.length === 2, JSON.stringify(asked))
	await rpc(u.token, 'session_init', { steamName: u.username })
	const cleared = await standing(u)
	check('session_init clears the report', cleared.standing === 'none' && cleared.reason === 'unreported', JSON.stringify(cleared))
}

async function casual(v, n, u) {
	await report(v, STOCK)
	await report(n, CRYPTID)
	await rpc(u.token, 'session_init', { steamName: u.username })
	const mode = MODE + 'c'
	const ok = await soloAdd(v, 4, mode)
	check('casual: valid may queue', !!ticketOf(ok), JSON.stringify(ok))
	if (ticketOf(ok)) await removeTicket(v, ok)
	const refused = await soloAdd(n, 4, mode)
	check('casual: none (disallowed mods) is refused, naming them', /aren't allowed in matchmaking: Cryptid/.test(errorOf(refused)), JSON.stringify(refused))
	const unreported = await soloAdd(u, 4, mode)
	check('casual: none (unreported) is refused', /reported its mods/.test(errorOf(unreported)), JSON.stringify(unreported))
}

async function ranked(v, n) {
	await report(v, STOCK)
	await report(n, CRYPTID)
	const mode = MODE + 'k'
	const modsChecked = await soloAdd(n, 4, mode, 'ranked')
	check('ranked without integrityEnforced: the mod check applies', /Cryptid/.test(errorOf(modsChecked)), JSON.stringify(modsChecked))
	await config({ integrityEnforced: true })
	try {
		const unverified = await soloAdd(v, 4, mode, 'ranked')
		check('ranked with integrityEnforced: valid but unverified is refused', !!errorOf(unverified) && !ticketOf(unverified), JSON.stringify(unverified))
		const set = await admin('admin_integrity_set', { userId: n.userId, verified: true })
		check('dev verdict set', set.ok, set.text)
		const verified = await standing(n)
		check('a verified player is verified whatever its mods', verified.standing === 'verified', JSON.stringify(verified))
		const ok = await soloAdd(n, 4, mode, 'ranked')
		check('ranked: dev-verified may queue whatever its mods', !!ticketOf(ok), JSON.stringify(ok))
		if (ticketOf(ok)) await removeTicket(n, ok)
	} finally {
		await config({ integrityEnforced: false })
	}
}

async function privateLobby(x, y) {
	await report(x, CRYPTID)
	await rpc(y.token, 'session_init', { steamName: y.username })
	let ok = true
	let lobby = null
	try {
		lobby = await lobbyWith([x, y], { modId: MOD })
	} catch (e) {
		ok = false
	}
	check('private lobbies are never gated (none + unreported seated)', ok && !!lobby)
	if (lobby) for (const p of [x, y]) p.socket.sendOp(ClientOp.LEAVE, {}, lobby.matchId)
}

async function group(g1, g2, g3) {
	for (const p of [g1, g2, g3]) await report(p, STOCK)
	await report(g2, CRYPTID)
	const mode = MODE + 'g'
	const lobby = await lobbyWith([g1, g2, g3], { modId: MOD })
	const created = await partyCreate(g1)
	const partyId = created.party.party_id
	const refused = await rpc(g1.token, 'group_queue_open', { partyId, mode })
	const r = refused.body && refused.body.refused
	check(
		'group open refused, naming the member and their mods',
		!!r && r.code === 'member_refused' && r.userId === g2.userId && r.reason === 'mods_not_allowed' && JSON.stringify(r.mods) === '["Cryptid"]',
		refused.text,
	)
	check('the refusal carries display text', !!r && /Cryptid/.test(r.message || ''), r && r.message)
	await report(g2, STOCK)
	const opened = await rpc(g1.token, 'group_queue_open', { partyId, mode })
	check('after a fresh report the group may open', opened.ok && !!opened.body.groupQueue, opened.text)
	await rpc(g3.token, 'session_init', { steamName: g3.username })
	const joined = await partyJoin(g3, partyId)
	check('an unreported member may not join the bound party', /reported its mods/.test((joined.error && joined.error.message) || ''), JSON.stringify(joined))
	await rpc(g1.token, 'group_queue_cancel', {})
	for (const p of [g1, g2, g3]) p.socket.sendOp(ClientOp.LEAVE, {}, lobby.matchId)
}

async function rejoin(r1, r2) {
	for (const p of [r1, r2]) await report(p, STOCK)
	const mode = MODE + 'r'
	const marks = [r1, r2].map((p) => p.socket.mark())
	for (const p of [r1, r2]) {
		const t = await soloAdd(p, 2, mode)
		if (!ticketOf(t)) throw new Error('rejoin queue: ' + JSON.stringify(t))
	}
	const found = await Promise.all([r1, r2].map((p, i) => p.socket.waitFor((x) => x.kind === 'matched', MATCH_MS, marks[i])))
	check('two valid players are matched', found.every(Boolean))
	if (!found.every(Boolean)) return
	const matchId = found[0].match_id
	let snap = null
	for (const p of [r1, r2]) {
		const at = p.socket.mark()
		const j = await p.socket.join(matchId, { modId: MOD, displayName: p.username })
		if (j.error) throw new Error('join: ' + JSON.stringify(j.error))
		snap = await p.socket.waitFor(snapshot(matchId), 5000, at)
	}
	const seated = snap.data.players
	check('the snapshot carries each seat standing', seated.length === 2 && seated.every((p) => p.standing === 'valid'), JSON.stringify(seated.map((p) => p.standing)))
	const host = snap.data.hostId === r1.userId ? r1 : r2
	const away = host === r1 ? r2 : r1
	await startGame([host, away], {})
	const active = await rpc(away.token, 'run_active', {})
	check(
		'run_active returns requiredStanding and the caller standing',
		active.ok && active.body.active && active.body.active.requiredStanding === 'valid' && active.body.standing.standing === 'valid',
		active.text,
	)

	await away.socket.request({ match_leave: { match_id: matchId } })
	await sleep(300)
	await report(away, CRYPTID)
	const refused = await away.socket.join(matchId, { modId: MOD, displayName: away.username })
	const message = (refused.error && refused.error.message) || ''
	let view = null
	try {
		view = JSON.parse(message.slice(message.indexOf('standing_refused:') + 'standing_refused:'.length))
	} catch (e) {
		// not the standing refusal
	}
	check(
		'rejoining with other mods is refused (standing_refused: + JSON)',
		message.indexOf('standing_refused:') !== -1 && !!view && view.reason === 'mods_not_allowed' && JSON.stringify(view.mods) === '["Cryptid"]',
		message,
	)
	const still = await rpc(away.token, 'run_active', {})
	check('the seat stays while refused (run_active still answers)', still.ok && !!still.body.active && still.body.standing.standing === 'none', still.text)
	await report(away, STOCK)
	const at = away.socket.mark()
	const back = await away.socket.join(matchId, { modId: MOD, displayName: away.username })
	const backSnap = await away.socket.waitFor(snapshot(matchId), 5000, at)
	check('after a fresh report the rejoin succeeds', !back.error && !!backSnap, JSON.stringify(back.error))
	for (const p of [r1, r2]) p.socket.sendOp(ClientOp.LEAVE, {}, matchId)
}

async function allowlistChange(h1, h2, s, o) {
	await config({ queueAllowedModIdsExtra: ['ClaudeControl'] })
	for (const p of [h1, h2, s, o]) await report(p, WITH_CC)
	const fine = await standing(h1)
	check('ClaudeControl allowed through Extra', fine.standing === 'valid', JSON.stringify(fine))
	const mode = MODE + 'a'
	// A queued group of two (looking for four, so it waits) and a queued solo.
	const lobby = await lobbyWith([h1, h2], { modId: MOD })
	const partyId = (await partyCreate(h1)).party.party_id
	const opened = await rpc(h1.token, 'group_queue_open', { partyId, mode })
	if (!opened.ok || !opened.body.groupQueue) throw new Error('group_queue_open: ' + opened.text)
	await partyJoin(h2, partyId)
	const queuedAt = h1.socket.mark()
	const added = await h1.socket.request({
		party_matchmaker_add: {
			party_id: partyId,
			min_count: 4,
			max_count: 4,
			query: query(mode, 'casual'),
			string_properties: props(mode, 'casual'),
			numeric_properties: { groupSize: 2 },
		},
	})
	check('the group queues', !!added.party_matchmaker_ticket, JSON.stringify(added))
	await h1.socket.waitFor(groupOp((d) => d.phase === 'queued'), 5000, queuedAt)
	const solo = await soloAdd(s, 4, mode)
	check('the solo queues', !!ticketOf(solo), JSON.stringify(solo))

	const marks = [h1, h2, s, o].map((p) => p.socket.mark())
	await config({ queueAllowedModIdsExtra: [] })
	const told = await Promise.all([h1, h2, s, o].map((p, i) => p.socket.waitFor(notification(108), 5000, marks[i])))
	check(
		'every online reporter hears STANDING_CHANGED (108) with the new standing',
		told.every((n) => n && n.content.standing === 'none' && JSON.stringify(n.content.disallowed) === '["ClaudeControl"]' && !('enforced' in n.content)),
		JSON.stringify(told.map((n) => n && n.content)),
	)
	const idle = await h1.socket.waitFor(groupOp((d) => d.phase === 'idle'), 5000, marks[0])
	check(
		'the queued group is cancelled naming the refused member (op 112 idle)',
		!!idle && idle.data.reason === 'member_refused' && !!idle.data.refused && [h1.userId, h2.userId].includes(idle.data.refused.userId) &&
			JSON.stringify(idle.data.refused.mods) === '["ClaudeControl"]',
		JSON.stringify(idle && idle.data),
	)
	const cancelled = await s.socket.waitFor(notification(103), 5000, marks[2])
	check(
		'the queued solo is told why (103 with code and mods)',
		!!cancelled && cancelled.content.code === 'mods_not_allowed' && JSON.stringify(cancelled.content.mods) === '["ClaudeControl"]' && cancelled.content.requeue === false,
		JSON.stringify(cancelled && cancelled.content),
	)
	const pushed = await h2.socket.waitFor((i) => i.kind === 'data' && i.op === ServerOp.PLAYER_INFO && i.data && i.data.info && i.data.info.standing === 'none', 5000, marks[1])
	check("the lobby hears the members' new standing", !!pushed, JSON.stringify(pushed && pushed.data))
	if (ticketOf(solo)) await removeTicket(s, solo)
	for (const p of [h1, h2]) p.socket.sendOp(ClientOp.LEAVE, {}, lobby.matchId)
}

async function devClient(d) {
	const reply = await report(d, DEV_CLIENT)
	check('the stock dev client is valid under the seeded Extra', reply.ok && reply.body.standing.standing === 'valid', reply.text)
	const t = await soloAdd(d, 4, MODE + 'd')
	check('the stock dev client may queue casual', !!ticketOf(t), JSON.stringify(t))
	if (ticketOf(t)) await removeTicket(d, t)
}

async function main() {
	const before = serverConfig()
	const baselineExtra = before.queueAllowedModIdsExtra || []
	check(
		'Extra holds the boot seed (MultiplayerPvP, ClaudeControl)',
		SEEDED_EXTRA.every((id) => baselineExtra.includes(id)),
		JSON.stringify(baselineExtra),
	)
	check('the config has no queueModsEnforced switch', !('queueModsEnforced' in before), JSON.stringify(Object.keys(before)))
	const pinned = before.queueAllowedModIds || []
	check(
		'Express pushed the pinned SMODS ids (MultiplayerAPI, MultiplayerSPDRN)',
		pinned.includes('MultiplayerAPI') && pinned.includes('MultiplayerSPDRN'),
		JSON.stringify(pinned),
	)
	const names = ['u', 'v', 'n', 'x', 'y', 'g1', 'g2', 'g3', 'r1', 'r2', 'h1', 'h2', 's', 'o', 'd']
	const players = await Promise.all(names.map((n) => player('st_' + n)))
	const [u, v, n, x, y, g1, g2, g3, r1, r2, h1, h2, s, o, d] = players
	restoreExtra = baselineExtra
	await config({ queueAllowedModIdsExtra: [] })
	try {
		await standings(u)
		await casual(v, n, u)
		await ranked(v, n)
		await privateLobby(x, y)
		await group(g1, g2, g3)
		await rejoin(r1, r2)
		await allowlistChange(h1, h2, s, o)
	} finally {
		await config({ queueAllowedModIdsExtra: baselineExtra, integrityEnforced: false })
	}
	try {
		await devClient(d)
	} finally {
		for (const p of players) p.socket.close()
	}
	const after = serverConfig()
	check(
		'config restored (Extra back to the seed, integrity off)',
		JSON.stringify(after.queueAllowedModIdsExtra) === JSON.stringify(baselineExtra) && after.integrityEnforced === false,
		JSON.stringify(after.queueAllowedModIdsExtra),
	)
	process.exit(summary('standing') === 0 ? 0 : 1)
}

// The Extra to put back if the run dies part-way (set once it is known).
let restoreExtra = null

main().catch(async (e) => {
	console.error(e)
	await config({ integrityEnforced: false, ...(restoreExtra ? { queueAllowedModIdsExtra: restoreExtra } : {}) })
	process.exit(2)
})
