// The instant queue, end to end, on a live Nakama (compose.e2e.yml): test
// players log in by name on a Community server (no Steam), take a rating on
// the PvP Expanded board, and queue through the realtime matchmaker with the
// tickets the game mod builds (window.ts). The website's floor 1200 and
// ceiling 400 are pushed through the config RPC, as the API pushes them.
//
// Time is simulated: the mod swaps a waiting player's ticket for one with the
// window of their wait so far every 30 seconds, so a test does the same swap
// at each simulated step instead of waiting minutes. Each step then gives the
// matchmaker a full pass (PASS_MS) to match, or not.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PASS_MS, TestClient, adminRpc, configure, sleep, testName } from './client'
import { type Ranges, instantOpenAt, rankedTicket, rankedWindow } from './window'

const RANGES: Ranges = { floor: 1200, ceiling: 400, floorMultiplier: 1, ceilingMultiplier: 1 }

interface Player {
	c: TestClient
	rating: number
}

let clients: TestClient[] = []

async function player(label: string, rating: number): Promise<Player> {
	const c = await new TestClient(testName(label)).connect()
	await c.setRating(rating)
	clients.push(c)
	return { c, rating }
}

// The first queue of a player, with `wait` seconds already behind them.
const enter = (p: Player, ranges: Ranges | null, wait = 0) => p.c.queue(rankedTicket(p.rating, wait, ranges))

// The mod's requeue step for everyone still waiting, then a matchmaker pass.
async function advance(waiting: Player[], wait: number, ranges: Ranges | null) {
	for (const p of waiting) await p.c.requeue(rankedTicket(p.rating, wait, ranges))
	await sleep(PASS_MS)
}

const idsOf = (...ps: Player[]) => ps.map((p) => p.c.userId).sort()
const matched = (p: Player) => p.c.matched.length > 0

// Whether the two waiting players' tickets can match at `wait`: a ticket needs
// only its own query to take in the other's rating (the matchmaker is
// one-sided).
function inWindow(rating: number, w: { lo: number | null; hi: number | null }): boolean {
	return (w.lo === null || rating >= Math.floor(w.lo)) && (w.hi === null || rating <= Math.ceil(w.hi))
}
function canMatch(a: Player, b: Player, wait: number, ranges: Ranges | null): boolean {
	return (
		inWindow(b.rating, rankedWindow(a.rating, wait, ranges)) || inWindow(a.rating, rankedWindow(b.rating, wait, ranges))
	)
}

beforeAll(async () => {
	// Fails at once, with the way to start it, when no server is up.
	await adminRpc('admin_ping', {}).catch((e) => {
		throw new Error(`No Nakama to test against. Start it: docker compose -f nakama/e2e/compose.e2e.yml up -d --wait (${e.message})`)
	})
})

beforeEach(async () => {
	await configure(RANGES)
})

afterEach(() => {
	for (const c of clients) c.close()
	clients = []
})

describe('players in the same range', () => {
	it('upper range: two players far apart queue into each other at once', async () => {
		const [a, b] = [await player('UpA', 1500), await player('UpB', 1900)]
		await enter(a, RANGES)
		await enter(b, RANGES)
		expect(await a.c.waitMatched(15_000)).toEqual(idsOf(a, b))
		expect(await b.c.waitMatched(1000)).toEqual(idsOf(a, b))
	})

	it('upper range, switched off: the same two players do not match', async () => {
		await configure(null)
		const [a, b] = [await player('OffA', 1500), await player('OffB', 1900)]
		await enter(a, null)
		await enter(b, null)
		await sleep(PASS_MS * 2)
		expect([matched(a), matched(b)]).toEqual([false, false])
	})

	it('lower range: two players far apart queue into each other at once', async () => {
		const [a, b] = [await player('LoA', 300), await player('LoB', 100)]
		await enter(a, RANGES)
		await enter(b, RANGES)
		expect(await a.c.waitMatched(15_000)).toEqual(idsOf(a, b))
	})

	it('lower range, switched off: the same two players do not match', async () => {
		await configure(null)
		const [a, b] = [await player('LoOffA', 300), await player('LoOffB', 100)]
		await enter(a, null)
		await enter(b, null)
		await sleep(PASS_MS * 2)
		expect([matched(a), matched(b)]).toEqual([false, false])
	})

	it('the two ranges do not mix: an upper and a lower player stay apart', async () => {
		const [hi, lo] = [await player('MixHi', 1500), await player('MixLo', 300)]
		await enter(hi, RANGES)
		await enter(lo, RANGES)
		await sleep(PASS_MS * 2)
		expect([matched(hi), matched(lo)]).toEqual([false, false])
	})
})

describe('a player in the range, and two players outside it', () => {
	it('the two outside players match each other and the one in the range keeps waiting', async () => {
		const x = await player('WaitX', 1500)
		await enter(x, RANGES)
		const [a, b] = [await player('OutA', 800), await player('OutB', 850)]
		await enter(a, RANGES)
		await enter(b, RANGES)
		expect(await a.c.waitMatched(15_000)).toEqual(idsOf(a, b))
		expect(await b.c.waitMatched(1000)).toEqual(idsOf(a, b))
		expect(matched(x)).toBe(false)

		// Still waiting: the next player in the range takes them straight away.
		const y = await player('WaitY', 1700)
		await enter(y, RANGES)
		expect(await x.c.waitMatched(15_000)).toEqual(idsOf(x, y))
	})
})

describe('a player in the range waits for one below it', () => {
	// X is in the upper range (1500, floor 1200) and L is 500 below X, 200
	// below the floor. L's window has to grow 500 wide to take X in: 150 and
	// 50 more every 30s, so at 210s. X's range opens up at 90s (the 300 to the
	// floor), and from there it too grows past the floor.
	it('the lower player takes the upper one in only once their window grows to reach them', async () => {
		const x = await player('GrowX', 1500)
		const l = await player('GrowL', 1000)
		await enter(x, RANGES)
		await enter(l, RANGES)
		await sleep(PASS_MS)

		let firstMatch: number | null = null
		for (let wait = 0; wait <= 270 && firstMatch === null; wait += 30) {
			if (wait > 0) await advance([x, l], wait, RANGES)
			const expected = canMatch(x, l, wait, RANGES)
			const actual = matched(x) && matched(l)
			expect(actual, `at ${wait}s`).toBe(expected)
			if (actual) firstMatch = wait
		}
		expect(firstMatch).toBe(210)
		expect(await x.c.waitMatched(1000)).toEqual(idsOf(x, l))
		expect(instantOpenAt(1500, RANGES)).toBe(90)
	})

	it('with the range off, the lower player needs the full window to reach, and the upper player is not held back', async () => {
		await configure(null)
		const x = await player('NoRangeX', 1500)
		const l = await player('NoRangeL', 1000)
		await enter(x, null)
		await enter(l, null)
		await sleep(PASS_MS)
		// Each player alone reaches 500 at 210s, the same moment, since the
		// range grows at the normal rate: the range changes who is in a pool,
		// not how fast a window grows.
		let firstMatch: number | null = null
		for (let wait = 0; wait <= 270 && firstMatch === null; wait += 30) {
			if (wait > 0) await advance([x, l], wait, null)
			const actual = matched(x) && matched(l)
			expect(actual, `at ${wait}s`).toBe(canMatch(x, l, wait, null))
			if (actual) firstMatch = wait
		}
		expect(firstMatch).toBe(210)
	})
})

describe('a third player queues between them, closer to the lower player', () => {
	it('the lower player and the third match; the upper player keeps waiting', async () => {
		const x = await player('TriX', 1500)
		const l = await player('TriL', 1000)
		await enter(x, RANGES)
		await enter(l, RANGES)
		await sleep(PASS_MS)
		for (const wait of [30, 60]) {
			await advance([x, l], wait, RANGES)
			expect([matched(x), matched(l)], `at ${wait}s`).toEqual([false, false])
		}

		// 1100 is outside the range (floor 1200), 100 above L, 400 below X.
		const m = await player('TriM', 1100)
		await enter(m, RANGES)
		expect(canMatch(m, l, 0, RANGES)).toBe(true)
		expect(canMatch(m, x, 0, RANGES)).toBe(false)
		expect(await l.c.waitMatched(15_000)).toEqual(idsOf(l, m))
		expect(await m.c.waitMatched(1000)).toEqual(idsOf(l, m))
		expect(matched(x)).toBe(false)

		// Alone, the upper player stays unmatched however long they wait.
		for (const wait of [90, 120, 210]) {
			await advance([x], wait, RANGES)
			expect(matched(x), `at ${wait}s`).toBe(false)
		}
	})

	it('a third player arriving as the lower player reaches the upper one: exactly two of the three match, and they could match each other', async () => {
		// At 210s L's window takes X in, and X's own window (grown past the
		// floor) takes in both L and the newcomer M. The matchmaker is free to
		// pick any pair that fits, but only two are ever matched (max count 2).
		const x = await player('LateX', 1500)
		const l = await player('LateL', 1000)
		await enter(x, RANGES)
		await enter(l, RANGES)
		await sleep(PASS_MS)
		for (const wait of [30, 60, 90, 120, 150, 180]) {
			await advance([x, l], wait, RANGES)
			expect([matched(x), matched(l)], `at ${wait}s`).toEqual([false, false])
		}
		const m = await player('LateM', 1100)
		await enter(m, RANGES)
		await advance([x, l], 210, RANGES)
		const made = [x, l, m].filter(matched)
		expect(made.length).toBe(2)
		// X and L queued 210s ago in this step; M has just queued.
		const [p, q] = made
		const waited = (who: Player) => (who === m ? 0 : 210)
		const fits =
			inWindow(q.rating, rankedWindow(p.rating, waited(p), RANGES)) ||
			inWindow(p.rating, rankedWindow(q.rating, waited(q), RANGES))
		expect(fits).toBe(true)
		expect(await made[0].c.waitMatched(1000)).toEqual(idsOf(made[0], made[1]))
		console.info(`at 210s with a third player: matched ${made.map((p) => p.rating).join(' and ')}`)
	})
})
