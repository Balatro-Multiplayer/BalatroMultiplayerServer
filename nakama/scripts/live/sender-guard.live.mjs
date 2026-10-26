// Live (Phase 0, outcome forging): the relay's sender rules
// (nakama/src/lobby/sender_guard.ts) against the local Nakama.
//  1. A guest forges pvp_win, pvp_player_lives, spdrn_player_won naming
//     someone else and spdrn_player_result for someone else: each is refused
//     to the forger (not_host / not_self) and reaches nobody.
//  2. The host's own referee messages, and a guest's own spdrn_player_won /
//     spdrn_player_result, still pass.
//  3. The rated result is the host's: an honest pair of reports after a
//     forgery settles 'agreed' with the host's winner, and a forger who also
//     lies in its report gets 'disputed' and moves no rating.
//  4. Host transfer: the host's socket drops, the next player is made host and
//     its referee messages pass; the old host, back as a guest, is refused.
//  5. The Nakama log has a "dropped ... not_host" line for a forgery.
// Needs ranked lobbies (on by default on a Dev server); without
// it the rating checks are skipped and the result checks run unranked.
// Run: node nakama/scripts/live/sender-guard.live.mjs
import {
	PREFIX,
	ServerOp,
	check,
	connect,
	deviceAuth,
	lobbyWith,
	nakamaLogsSince,
	rpc,
	sleep,
	startGame,
	startSession,
	summary,
} from './lib.mjs'

const stamp = Date.now().toString(36)
const MOD = PREFIX + 'sg_mod'
const MODE = PREFIX + 'sg_mode'
const QUIET_MS = 1500

async function player(name) {
	const p = await deviceAuth(`sg_${stamp}_${name}`)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await startSession(p)
	return p
}

const isAction = (key) => (i) => i.kind === 'data' && i.op === ServerOp.ACTION && i.data && i.data.action === key
const isRejection = (cid) => (i) => i.kind === 'data' && i.op === ServerOp.ACTION_REJECTED && i.data && i.data.cid === cid

// Sends a relayed broadcast from `from` and reports what each socket saw:
// {rejected: reason|null, seen: {username: envelope|null}}.
async function relay(from, key, params, everyone) {
	const marks = new Map(everyone.map((p) => [p, p.socket.mark()]))
	const cid = from.socket.action(key, params, '*')
	await sleep(QUIET_MS)
	const rejection = from.socket.inbox.slice(marks.get(from)).find(isRejection(cid))
	const seen = {}
	for (const p of everyone) {
		const got = p.socket.inbox.slice(marks.get(p)).find((i) => isAction(key)(i) && i.data.cid === cid)
		seen[p.username] = got ? got.data : null
	}
	return { rejected: rejection ? rejection.data.reason : null, seen }
}

const nobodySaw = (r) => Object.values(r.seen).every((v) => v === null)
const allSaw = (r, from) => Object.values(r.seen).every((v) => v && v.from === from.userId)

async function rating(p) {
	const r = await rpc(p.token, 'rating_get', { modId: MOD, mode: MODE, playerId: p.userId })
	return r.ok ? r.body : null
}

async function report(p, placements) {
	return p.socket.ask('mpapi_report_result', { placements })
}

async function runOf(p, runId) {
	for (let i = 0; i < 10; i++) {
		const r = await rpc(p.token, 'run_get', { runId })
		if (r.ok && r.body && r.body.status) return r.body
		await sleep(1000)
	}
	return null
}

async function main() {
	const logsFrom = new Date().toISOString()
	const a = await player('a')
	const b = await player('b')
	const c = await player('c')

	// --- 1-3: a hosts, b forges ------------------------------------------------
	let ranked = true
	let lobby
	try {
		lobby = await lobbyWith([a, b], { modId: MOD, maxPlayers: 2, rankedMode: MODE })
	} catch (e) {
		console.log(`  info: ranked lobby refused (${e.message.slice(0, 120)}); running unranked`)
		ranked = false
		lobby = await lobbyWith([a, b], { modId: MOD, maxPlayers: 2 })
	}
	const pair = [a, b]
	const started = await startGame(pair, { stake: 1 })
	const before = ranked ? { a: await rating(a), b: await rating(b) } : null

	const winForged = await relay(b, 'pvp_win', { winner_id: b.userId }, pair)
	check('guest pvp_win refused as not_host', winForged.rejected === 'not_host', JSON.stringify(winForged))
	check('guest pvp_win reached nobody (not even its own loopback)', nobodySaw(winForged), JSON.stringify(winForged.seen))

	const livesForged = await relay(b, 'pvp_player_lives', { player_id: a.userId, lives: 0, lost: 4 }, pair)
	check('guest pvp_player_lives refused as not_host', livesForged.rejected === 'not_host', JSON.stringify(livesForged))
	check('guest pvp_player_lives reached nobody', nobodySaw(livesForged))

	const wonForged = await relay(b, 'spdrn_player_won', { player_id: a.userId }, pair)
	check('guest spdrn_player_won{other} refused as not_self', wonForged.rejected === 'not_self', JSON.stringify(wonForged))
	check('guest spdrn_player_won{other} reached nobody', nobodySaw(wonForged))

	const resultForged = await relay(b, 'spdrn_player_result', { player_id: a.userId, furthest_ante: 1 }, pair)
	check('guest spdrn_player_result{other} refused as not_self', resultForged.rejected === 'not_self', JSON.stringify(resultForged))
	check('guest spdrn_player_result{other} reached nobody', nobodySaw(resultForged))

	const endForged = await relay(b, 'pvp_end_pvp', { loser_id: a.userId }, pair)
	check('guest pvp_end_pvp refused', endForged.rejected === 'not_host' && nobodySaw(endForged), JSON.stringify(endForged))

	// Honest messages still pass.
	const ownResult = await relay(b, 'spdrn_player_result', { player_id: b.userId, furthest_ante: 2 }, pair)
	check('guest own spdrn_player_result passes', !ownResult.rejected && allSaw(ownResult, b), JSON.stringify(ownResult))
	const ownWin = await relay(b, 'spdrn_player_won', { player_id: b.userId }, pair)
	check('guest own spdrn_player_won passes', !ownWin.rejected && allSaw(ownWin, b), JSON.stringify(ownWin))
	const surv = await relay(a, 'spdrn_player_won', { player_id: b.userId }, pair)
	check('host spdrn_player_won naming a survivor passes', !surv.rejected && allSaw(surv, a), JSON.stringify(surv))
	const rosterOk = await relay(b, 'pvp_player_result', { jokers: [], deck_back: 'b_red' }, pair)
	check('unruled pvp_player_result from a guest passes', !rosterOk.rejected && allSaw(rosterOk, b), JSON.stringify(rosterOk))
	const livesOk = await relay(a, 'pvp_player_lives', { player_id: b.userId, lives: 3, lost: 1 }, pair)
	check('host pvp_player_lives passes to everyone', !livesOk.rejected && allSaw(livesOk, a), JSON.stringify(livesOk))
	const winOk = await relay(a, 'pvp_win', { winner_id: a.userId }, pair)
	check('host pvp_win passes to everyone', !winOk.rejected && allSaw(winOk, a), JSON.stringify(winOk))

	// Both clients report what they received: only the host's pvp_win.
	const aWins = [
		{ playerId: a.userId, place: 1, performance: 1 },
		{ playerId: b.userId, place: 2, performance: 0 },
	]
	const ra = await report(a, aWins)
	const rb = await report(b, aWins)
	check('both report the host referee result', ra.ok && rb.ok, JSON.stringify([ra, rb]))
	const run1 = await runOf(a, started.runId)
	check(
		'run settles agreed with the host winner',
		run1 && run1.status === 'agreed' && run1.placements.find((p) => p.place === 1).playerId === a.userId,
		run1 ? JSON.stringify({ status: run1.status, placements: run1.placements }) : 'no run',
	)
	let mid = null
	if (ranked) {
		await sleep(1000)
		mid = { a: await rating(a), b: await rating(b) }
		check(
			'rating moved for the host winner, not the forger',
			mid.a && mid.b && mid.a.rating > before.a.rating && mid.b.rating < before.b.rating && mid.a.wins === before.a.wins + 1,
			JSON.stringify({ before, mid }),
		)
	}

	// A forger that also lies in its own report: disputed, no rating change.
	const started2 = await startGame(pair, { stake: 1 })
	await relay(b, 'pvp_win', { winner_id: b.userId }, pair)
	await relay(a, 'pvp_win', { winner_id: a.userId }, pair)
	const ra2 = await report(a, aWins)
	const rb2 = await report(b, [
		{ playerId: b.userId, place: 1, performance: 1 },
		{ playerId: a.userId, place: 2, performance: 0 },
	])
	check('second match: both reports accepted', ra2.ok && rb2.ok, JSON.stringify([ra2, rb2]))
	const run2 = await runOf(a, started2.runId)
	check(
		'a lying forger gets disputed, recorded with the host placements',
		run2 && run2.status === 'disputed' && run2.placements.find((p) => p.place === 1).playerId === a.userId,
		run2 ? JSON.stringify({ status: run2.status, placements: run2.placements }) : 'no run',
	)
	if (ranked) {
		await sleep(1000)
		const after = { a: await rating(a), b: await rating(b) }
		check(
			'disputed run moved no rating',
			after.a.rating === mid.a.rating && after.b.rating === mid.b.rating && after.b.gamesPlayed === mid.b.gamesPlayed,
			JSON.stringify({ mid, after }),
		)
	}
	for (const p of pair) {
		await rpc(p.token, 'lobby_leave', {})
		p.socket.close()
		p.socket = null
	}
	await sleep(1000)

	// --- 4: host transfer -------------------------------------------------------
	const a2 = a
	const trio = [a2, b, c]
	const lobby2 = await lobbyWith(trio, { modId: MOD, maxPlayers: 3 })
	await startGame(trio, { stake: 1 })
	const bMark = b.socket.mark()
	a2.socket.close()
	const changed = await b.socket.waitFor(
		(i) => i.kind === 'data' && i.op === ServerOp.EVENT && i.data && i.data.type === 'host_changed',
		10000,
		bMark,
	)
	check('host drop: b is made host', changed && changed.data.playerId === b.userId, JSON.stringify(changed && changed.data))
	const rest = [b, c]
	const newHostLives = await relay(b, 'pvp_player_lives', { player_id: c.userId, lives: 2, lost: 1 }, rest)
	check('new host pvp_player_lives passes', !newHostLives.rejected && allSaw(newHostLives, b), JSON.stringify(newHostLives))
	const newHostWin = await relay(b, 'pvp_player_won', { player_id: c.userId }, rest)
	check('new host pvp_player_won passes', !newHostWin.rejected && allSaw(newHostWin, b), JSON.stringify(newHostWin))
	const guestAfter = await relay(c, 'pvp_win', { winner_id: c.userId }, rest)
	check('remaining guest still refused after the transfer', guestAfter.rejected === 'not_host' && nobodySaw(guestAfter), JSON.stringify(guestAfter))

	// The old host comes back: a guest now.
	a2.socket = await connect(a2)
	const rejoined = await a2.socket.join(lobby2.matchId, { modId: MOD, displayName: a2.username })
	check('old host rejoins', !rejoined.error, JSON.stringify(rejoined.error || ''))
	await a2.socket.waitFor((i) => i.kind === 'data' && i.op === ServerOp.SNAPSHOT, 5000)
	const oldHost = await relay(a2, 'pvp_win', { winner_id: a2.userId }, [a2, b, c])
	check('old host, back as a guest, is refused', oldHost.rejected === 'not_host' && nobodySaw(oldHost), JSON.stringify(oldHost))
	const newHostAgain = await relay(b, 'pvp_win', { winner_id: c.userId }, [a2, b, c])
	check('new host pvp_win reaches the rejoined old host too', !newHostAgain.rejected && allSaw(newHostAgain, b), JSON.stringify(newHostAgain))

	for (const p of [a2, b, c]) {
		await rpc(p.token, 'lobby_leave', {})
		if (p.socket) p.socket.close()
	}

	// --- 5: the drop is logged ---------------------------------------------------
	await sleep(1000)
	const logs = nakamaLogsSince(logsFrom)
	const line = `dropped pvp_win from ${b.userId} (not_host; host ${a.userId}`
	check('Nakama logs the dropped forgery', logs.includes(line), line)
}

main()
	.catch((e) => {
		check('script ran', false, e.stack || String(e))
	})
	.finally(() => {
		process.exit(summary('sender-guard') ? 1 : 0)
	})
