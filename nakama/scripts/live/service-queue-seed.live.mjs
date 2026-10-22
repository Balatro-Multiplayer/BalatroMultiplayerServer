// Live: leaves one OPEN service-queue item of every type behind, for working
// the web page by hand or from a browser driver (the queue page's playwright
// pass). The items come from service-queue.live.mjs's own scenarios, through
// the real paths; no action is taken on them. Prints (and, with an output
// path, writes) the item ids plus web logins for the throwaway moderator and
// admin.
//
//   node nakama/scripts/live/service-queue-seed.live.mjs [out.json]            # all but integrity
//   node nakama/scripts/live/service-queue-seed.live.mjs [out.json] integrity  # integrity items only
//
// Needs the same as service-queue.live.mjs: moderation up for flagged chat,
// and api-green with DEV_FAKE_LAUNCHER_STRATEGY=true for integrity. The
// server config is put back as found. cleanup.live.mjs removes everything.
import { writeFileSync } from 'node:fs'
import { PREFIX, admin, check, express, lobbyWith, poll, rpc, sleep, startGame, summary } from './lib.mjs'
import {
	configSnapshot,
	forfeitGame,
	itemFor,
	pgId,
	player,
	privateLobby,
	rankedDispute,
	refuseChallenge,
	restoreConfig,
	staffRow,
} from './service-queue.live.mjs'

const [outPath, mode] = process.argv.slice(2)

// The second report in the private lobby (b against a, a counter-report) and
// a third player's report, so the page shows pile-ons and count badges.
async function counterReport(a, b) {
	const counter = await rpc(b.token, 'report_submit', { reportedUserId: a.userId, type: 'griefing', message: 'seed: counter-report' })
	check('seed: counter-report filed', counter.ok, counter.text.slice(0, 160))
	return counter.ok ? await itemFor('report', String(counter.body.reportId), 15000) : null
}

async function integrityItems() {
	const [i1, i2] = [await player('si1'), await player('si2')]
	await lobbyWith([i1, i2], { modId: PREFIX + 'mod' })
	await startGame([i1, i2], {})
	const placements = [i1, i2].map((p, i) => ({ playerId: p.userId, place: i + 1 }))
	for (const p of [i1, i2]) await p.socket.ask('mpapi_report_result', { placements })
	await poll(() => pgId(i1.userId), 40000)
	for (const p of [i1, i2]) p.socket.sendOp(1, {})
	await sleep(800)
	const p1 = pgId(i1.userId)
	const day = new Date().toISOString().slice(0, 10)
	for (let n = 0; n < 3; n++) {
		check(`seed: integrity challenge ${n + 1} refused`, await refuseChallenge(i1))
		await sleep(1200)
	}
	const repeated = await itemFor('integrity', `${p1}:${day}`, 15000)
	check('seed: integrity item raised', !!repeated)
	for (const p of [i1, i2]) p.socket.close()
	return { integrity: repeated }
}

async function main() {
	const snapshot = configSnapshot()
	if (mode === 'integrity') snapshot.integrityEnforced = false
	const mod = staffRow(PREFIX + 'sq_mod', ['moderator'])
	const adm = staffRow(PREFIX + 'sq_admin', ['admin'])
	let items = {}
	try {
		if (mode === 'integrity') {
			await admin('admin_config_set', { integrityEnforced: false })
			items = await integrityItems()
		} else {
			await admin('admin_config_set', { chatEnabled: true })
			const forfeit = forfeitGame()
			const [a, b, c, d] = [await player('a'), await player('b'), await player('c'), await player('d')]
			for (const p of [a, b]) await rpc(p.token, 'chat_enable', {})
			const P = await privateLobby(a, b)
			const counter = await counterReport(a, b)
			const R = await rankedDispute(c, d)
			const F = await forfeit
			items = {
				antiCheatElapsed: P.acA,
				antiCheatHash: P.acB,
				privateConflict: P.conflict,
				flaggedChat: P.flagged,
				privateReport: P.report,
				counterReport: counter,
				rankedConflict: R.conflict,
				rankedReport: R.report,
				forfeit: F.itemId,
				runIds: { private: P.runId, ranked: R.runId, forfeit: F.runId },
			}
			for (const p of [a, b, c, d]) p.socket.close()
		}
	} finally {
		await restoreConfig(snapshot)
	}
	const open = await express('GET', '/api/webadmin/service-queue?status=open&limit=100', { token: adm.token })
	check('seed: every seeded item is open', open.ok, open.text.slice(0, 160))
	const out = { items, staff: { moderator: mod, admin: adm } }
	console.log(JSON.stringify(out, null, 2))
	if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 2))
}

main()
	.catch((e) => {
		console.error(e)
		process.exitCode = 2
	})
	.finally(() => {
		if (process.exitCode !== 2) process.exitCode = summary('service-queue-seed.live') ? 1 : 0
		setTimeout(() => process.exit(process.exitCode), 500)
	})
