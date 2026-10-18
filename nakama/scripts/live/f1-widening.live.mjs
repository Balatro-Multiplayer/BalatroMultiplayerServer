// Live (F1): the Nakama matchmaker behaviour MPAPI's ranked window widening
// (api/matchmaking/api.lua) relies on. The window lives in each ticket's
// query, which Nakama can't change, so the client widens by withdrawing its
// ticket and adding a wider one. That only works if:
//   1. A fresh ticket whose query takes in a passive one is matched with it,
//      even when the passive one's own (narrower) query leaves the fresh one
//      out: the queries are one-sided (matchmaker.rev_precision off).
//   2. matchmaker_remove of a ticket the matchmaker already spent answers an
//      error, so the client knows to keep its matched callback.
// Casual tickets on the test mod: no rating board, no ranked gate.
// Run: BMP_TEST_PREFIX=f1test_ node nakama/scripts/live/f1-widening.live.mjs
// Clean up: BMP_TEST_PREFIX=f1test_ node nakama/scripts/live/cleanup.live.mjs
import { PREFIX, check, connect, deviceAuth, rpc, sleep, summary } from './lib.mjs'

const MOD = PREFIX + 'mod'
const MODE = PREFIX + 'widen'
// Local matchmaker.interval_sec is 2: three passes.
const PASSES_MS = 6500

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	p.socket = await connect(p)
	return p
}

// A ticket rated `rating` that takes in ratings within `spread`, built as
// MPAPI.matchmaking._nakama_ticket builds a ranked one.
function add(p, rating, spread) {
	return p.socket.request({
		matchmaker_add: {
			min_count: 2,
			max_count: 2,
			query: `+properties.modId:${MOD} +properties.mode:${MODE} +properties.kind:casual +properties.rating:>=${rating - spread} +properties.rating:<=${rating + spread}`,
			string_properties: { modId: MOD, mode: MODE, kind: 'casual' },
			numeric_properties: { rating },
		},
	})
}

const ticketOf = (t) => t && t.matchmaker_ticket && t.matchmaker_ticket.ticket
const remove = (p, ticket) => p.socket.request({ matchmaker_remove: { ticket } })
const matched = (p, since, ms) => p.socket.waitFor((x) => x.kind === 'matched', ms, since)

async function main() {
	const [a, b] = [await player('a'), await player('b')]
	try {
		const marks = [a.socket.mark(), b.socket.mark()]
		const ta = ticketOf(await add(a, 550, 150))
		check('A queued at 550 +-150', !!ta)
		// Let A's searching pass go by (a min == max ticket searches once).
		await sleep(PASSES_MS)
		const tb = ticketOf(await add(b, 900, 150))
		check('B queued at 900 +-150', !!tb)
		const none = await matched(b, marks[1], PASSES_MS)
		check('350 apart at +-150: no match', none === null, JSON.stringify(none))

		// B widens the way the client does: withdraw, then add wider.
		const removed = await remove(b, tb)
		check('withdrawing an unmatched ticket succeeds', !removed.error && !removed.timeout, JSON.stringify(removed))
		const tb2 = ticketOf(await add(b, 900, 400))
		check('B queued again at 900 +-400', !!tb2)
		const [ma, mb] = await Promise.all([matched(a, marks[0], PASSES_MS * 2), matched(b, marks[1], PASSES_MS * 2)])
		check(
			"B's wider ticket matches A's passive one, though A's +-150 leaves B out",
			!!ma && !!mb && ma.ticket === ta && mb.ticket === tb2 && ma.match_id === mb.match_id,
			JSON.stringify({ a: ma && ma.ticket, b: mb && mb.ticket }),
		)

		const late = await remove(a, ta)
		check('withdrawing a spent (matched) ticket answers an error', !!late.error, JSON.stringify(late))
	} finally {
		a.socket.close()
		b.socket.close()
	}
	process.exitCode = summary('f1-widening') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
