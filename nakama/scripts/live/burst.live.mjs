// Live: a burst of replay events past Nakama's old match input queue (128).
// Overnight F5: a 261-event burst stored only 128. Two players, two games:
//  1. 261 events + the closing 'chk' as single mpapi_log_event messages sent at
//     once (the old client): all stored, and the log check says 'match'
//  2. the same as mpapi_log_events batches of up to 50 (the new client)
// Needs match.input_queue_size 1024 (local.yml / prod.yml) and a restart.
// Also reads the Nakama log for the refusal line after a forced rate limit.
// Run: node nakama/scripts/live/burst.live.mjs
import { PREFIX, ServerOp, check, connect, deviceAuth, lobbyWith, rpc, sha256Hex, sleep, startGame, startSession, summary } from './lib.mjs'

const EVENTS = 261

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await startSession(p)
	p.socket = await connect(p)
	return p
}

function events() {
	return Array.from({ length: EVENTS }, (_, i) => [i + 1, 'play', [i]])
}

function carbonOf(list) {
	return sha256Hex(`[${list.map(([t, op, args]) => JSON.stringify([t, op, args])).join(',')}]`)
}

async function storedCount(a, b, runId) {
	const placements = [{ playerId: a.userId, place: 1 }, { playerId: b.userId, place: 2 }]
	await a.socket.ask('mpapi_report_result', { placements })
	await b.socket.ask('mpapi_report_result', { placements })
	await sleep(2000)
	const logs = await rpc(b.token, 'run_logs', { runId, playerId: b.userId })
	const bl = logs.ok && logs.body.logs && logs.body.logs[b.userId]
	const run = await rpc(b.token, 'run_get', { runId })
	const checks = run.ok && run.body && (run.body.run || run.body).logChecks
	return { count: bl ? bl.eventCount : -1, checks }
}

async function main() {
	const stamp = Date.now().toString(36)
	for (const mode of ['single', 'batch']) {
		const a = await player(`bu_${stamp}_${mode}_a`)
		const b = await player(`bu_${stamp}_${mode}_b`)
		await lobbyWith([a, b])
		const { runId } = await startGame([a, b], {})
		const list = events()
		const carbon = carbonOf(list)
		const mark = b.socket.mark()
		if (mode === 'single') {
			for (const [t, opcode, args] of list) b.socket.action('mpapi_log_event', { t, opcode, args, run: runId })
		} else {
			for (let at = 0; at < list.length; at += 50) {
				const chunk = list.slice(at, at + 50).map(([t, opcode, args]) => ({ t, opcode, args, run: runId }))
				b.socket.action('mpapi_log_events', { events: chunk })
			}
		}
		b.socket.action('mpapi_log_event', { t: 99999, opcode: 'chk', args: { carbon }, run: runId })
		await sleep(3000)
		const refused = b.socket.inbox.slice(mark).filter((i) => i.kind === 'data' && i.op === ServerOp.ACTION_REJECTED)
		check(`${mode}: nothing refused`, refused.length === 0, JSON.stringify(refused.slice(0, 2).map((r) => r.data)))
		const got = await storedCount(a, b, runId)
		check(`${mode}: all ${EVENTS} events and the closing check stored`, got.count === EVENTS + 1, `stored ${got.count}`)
		check(`${mode}: the log check matches`, !!got.checks && got.checks[b.userId] === 'match', JSON.stringify(got.checks))
		a.socket.sendOp(1, {})
		b.socket.sendOp(1, {})
		await sleep(500)
		a.socket.close()
		b.socket.close()
	}
	console.log(`  info: prefix ${PREFIX}; for a forced refusal, look in the Nakama log for "refused mpapi_log_events from"`)
	process.exitCode = summary('burst.live') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
