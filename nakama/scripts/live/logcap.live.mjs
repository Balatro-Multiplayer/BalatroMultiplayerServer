// Live: the replay log's 20,000-event cap (MAX_LOG_EVENTS). One player of a
// private 2-player game sends small log events at just under the 20/s log
// budget until it is past the cap, so it takes ~17.5 minutes. Checks:
//  - nothing is refused for the budget (the pacing is right) or for the cap
//    (events past it are dropped silently, as designed)
//  - the stored log holds exactly 20,000 events, marked truncated
//  - a truncated log is not hash-checked as a match (log_check: 'incomplete')
//  - the lobby still answers quickly near the cap (the log is copied per event)
// Set LOGCAP_EVENTS to try a smaller number (no cap reached; the run then only
// checks pacing and counts). Run: node nakama/scripts/live/logcap.live.mjs
import { PREFIX, ServerOp, check, connect, deviceAuth, lobbyWith, rpc, sleep, startGame, summary } from './lib.mjs'

const CAP = 20_000
const TOTAL = Number(process.env.LOGCAP_EVENTS || CAP + 60)
const PER_SECOND = 19 // the log budget refills 20/s (burst 200)

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	p.socket = await connect(p)
	return p
}

async function latency(p) {
	const t0 = Date.now()
	const r = await p.socket.ask('mpapi_ready', { ready: false }, 15000)
	return { ms: Date.now() - t0, r }
}

async function main() {
	const stamp = Date.now().toString(36)
	const a = await player(`lc_${stamp}_a`)
	const b = await player(`lc_${stamp}_b`)
	await lobbyWith([a, b])
	const { runId } = await startGame([a, b], {})
	const first = await latency(a)
	console.log(`  info: action round trip at 0 events: ${first.ms}ms ${JSON.stringify(first.r)}`)

	const before = b.socket.mark()
	const t0 = Date.now()
	let sent = 0
	let slowest = 0
	while (sent < TOTAL) {
		const tick = Date.now()
		for (let i = 0; i < PER_SECOND && sent < TOTAL; i++) {
			b.socket.action('mpapi_log_event', { t: sent, opcode: 'e', args: sent, run: runId })
			sent++
		}
		if (sent % 2000 < PER_SECOND) {
			const l = await latency(a)
			slowest = Math.max(slowest, l.ms)
			console.log(`  info: ${sent} sent, ${((Date.now() - t0) / 1000).toFixed(0)}s, round trip ${l.ms}ms, b socket closed=${b.socket.closed}`)
		}
		if (b.socket.closed) break
		await sleep(Math.max(0, 1000 - (Date.now() - tick)))
	}
	await sleep(2000)
	const rejected = b.socket.inbox.slice(before).filter((i) => i.kind === 'data' && i.op === ServerOp.ACTION_REJECTED)
	check('socket stayed open for the whole send', !b.socket.closed, `closed=${b.socket.closed} code=${b.socket.closeCode}`)
	check(`${sent} log events sent at ${PER_SECOND}/s: none refused`, sent === TOTAL && rejected.length === 0, `${rejected.length} rejections ${JSON.stringify(rejected.slice(0, 2).map((r) => r.data))}`)
	const relayed = a.socket.inbox.filter((i) => i.kind === 'data' && i.op === ServerOp.ACTION && i.data && i.data.action === 'mpapi_log_event').length
	check(`the other player got every stored event relayed (${Math.min(TOTAL, CAP)})`, relayed === Math.min(TOTAL, CAP), `${relayed} relayed`)
	const near = await latency(a)
	check('the lobby still answers quickly at the cap (< 2s)', near.ms < 2000 && !near.r.timeout, `${near.ms}ms, slowest ${Math.max(slowest, near.ms)}ms`)

	const placements = [{ playerId: a.userId, place: 1 }, { playerId: b.userId, place: 2 }]
	const ra = await a.socket.ask('mpapi_report_result', { placements })
	const rb = await b.socket.ask('mpapi_report_result', { placements })
	check('both report', ra.ok && rb.ok, JSON.stringify([ra, rb]))
	await sleep(1500)
	const logs = await rpc(b.token, 'run_logs', { runId, playerId: b.userId })
	const bl = logs.ok && logs.body.logs && logs.body.logs[b.userId]
	const capped = TOTAL > CAP
	check(
		capped ? `stored log holds exactly ${CAP} events, truncated` : `stored log holds all ${TOTAL} events, not truncated`,
		!!bl && bl.eventCount === Math.min(TOTAL, CAP) && bl.truncated === capped,
		bl ? `eventCount ${bl.eventCount} truncated ${bl.truncated}` : logs.text.slice(0, 160),
	)
	const run = await rpc(b.token, 'run_get', { runId })
	const checkB = run.ok && run.body && (run.body.run || run.body).logChecks
	console.log(`  info: log checks ${JSON.stringify(checkB)}`)
	if (capped) check('a truncated log is not checked as a match', !!checkB && checkB[b.userId] !== 'match', JSON.stringify(checkB))
	a.socket.sendOp(1, {})
	b.socket.sendOp(1, {})
	await sleep(500)
	a.socket.close()
	b.socket.close()
	console.log(`  info: prefix ${PREFIX}, run ${runId}, ${((Date.now() - t0) / 1000).toFixed(0)}s`)
	process.exitCode = summary('logcap.live') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
