// Live (W5): the ranked kill switch (rankedEnabled=false) at the matchmaker,
// flipped the real way: webadmin PATCH /api/webadmin/config/feature-flags,
// which writes Postgres server_config and pushes it to Nakama.
//   1. rankedEnabled=false: a ranked ticket is refused with the reason; a
//      casual ticket is still accepted.
//   2. A ranked group matched after the switch flips (tickets added just
//      before it) is refused in the matched hook: what do its players get?
//   3. Queue ban on one player of a matched group (the other is told to
//      requeue: QUEUE_CANCELLED requeue:true).
//   4. admin_queue_cancel on a queued player: QUEUE_CANCELLED requeue:false.
// Restores rankedEnabled=true at the end.
// Run: BMP_TEST_PREFIX=w5test_ node nakama/scripts/live/w5-ranked-switch.live.mjs
import { PREFIX, admin, check, express, psql, q, sleep, summary, webJwt } from './lib.mjs'
import { MOD, MODE, player } from './w5-seed.live.mjs'

const adminId = () => psql('bmp', `select id from players where steam_name=${q(PREFIX + 'admin')}`)[0][0]
const nkConfig = () => JSON.parse(psql('nakama', "select value::text from storage where collection='server_config' and key='global'")[0][0])

async function setRanked(enabled) {
	const jwt = webJwt(adminId(), PREFIX + 'admin')
	return express('PATCH', '/api/webadmin/config/feature-flags', { token: jwt, body: { rankedEnabled: enabled } })
}

function ticket(p, kind, count = 2) {
	return p.socket.request({
		matchmaker_add: {
			min_count: count,
			max_count: count,
			query: `+properties.modId:${MOD} +properties.mode:${MODE} +properties.kind:${kind}`,
			string_properties: { modId: MOD, mode: MODE, kind },
		},
	})
}

const removeTicket = (p, t) => t && t.matchmaker_ticket && p.socket.request({ matchmaker_remove: { ticket: t.matchmaker_ticket.ticket } })
const cancelled = (p, since, ms) => p.socket.waitFor((x) => x.kind === 'notification' && x.code === 103, ms, since)

async function main() {
	const [a, b] = [await player('a'), await player('b')]
	try {
		// 1. The switch at matchmaker_add.
		const off = await setRanked(false)
		check('webadmin flips rankedEnabled off and pushes it', off.status === 200 && nkConfig().rankedEnabled === false, `${off.status} ${JSON.stringify(nkConfig())}`)
		const refused = await ticket(a, 'ranked')
		check('ranked ticket refused with the reason', !!refused.error && /Ranked matchmaking is currently disabled/.test(JSON.stringify(refused.error)), JSON.stringify(refused))
		const casual = await ticket(a, 'casual', 3)
		check('casual ticket still accepted', !!casual.matchmaker_ticket, JSON.stringify(casual))
		await removeTicket(a, casual)
		const on = await setRanked(true)
		check('webadmin flips rankedEnabled back on', on.status === 200 && nkConfig().rankedEnabled === true)

		// 2. A group matched after the switch flips. Race the switch against the
		// matcher's 2s pass: retry until both tickets are in before the flip.
		let outcome = null
		for (let attempt = 0; attempt < 5 && !outcome; attempt++) {
			await setRanked(true)
			const marks = [a.socket.mark(), b.socket.mark()]
			const ta = await ticket(a, 'ranked')
			const [tb] = await Promise.all([ticket(b, 'ranked'), setRanked(false)])
			if (!ta.matchmaker_ticket || !tb.matchmaker_ticket) {
				await removeTicket(a, ta)
				await removeTicket(b, tb)
				continue
			}
			const got = await Promise.all([a, b].map((p, i) => p.socket.waitFor((x) => (x.kind === 'matched' || (x.kind === 'notification' && x.code === 103)), 8000, marks[i])))
			outcome = got
		}
		console.log('SWITCH-RACE', JSON.stringify(outcome))
		check('group matched after the switch: no lobby is made', !!outcome && outcome.every((m) => !m || !m.match_id), JSON.stringify(outcome))
		check('group matched after the switch: players are told (QUEUE_CANCELLED or a matched event)', !!outcome && outcome.every((m) => !!m), JSON.stringify(outcome))
		await setRanked(true)

		// 3. One refused player in a matched group: the other gets requeue:true.
		// Ban b from the queue right after both tickets are in.
		let notice = null
		for (let attempt = 0; attempt < 5 && !notice; attempt++) {
			const since = a.socket.mark()
			const ta = await ticket(a, 'ranked')
			const [tb] = await Promise.all([
				ticket(b, 'ranked'),
				admin('admin_ban_apply', { userId: b.userId, type: 'queue', banId: 'w5test_qban', expiresAt: Date.now() + 60000, reason: 'w5 test' }),
			])
			if (!tb.matchmaker_ticket) {
				await removeTicket(a, ta)
				await admin('admin_ban_lift', { userId: b.userId, banId: 'w5test_qban' })
				continue
			}
			notice = await cancelled(a, since, 8000)
			await admin('admin_ban_lift', { userId: b.userId, banId: 'w5test_qban' })
		}
		check('matched group with a newly banned player: the other gets QUEUE_CANCELLED requeue:true', !!notice && notice.content.requeue === true, JSON.stringify(notice))

		// 4. admin_queue_cancel on a queued player.
		const since = a.socket.mark()
		const ta = await ticket(a, 'ranked')
		const r = await admin('admin_queue_cancel', { userId: a.userId, reason: 'mods_outdated' })
		const n = await cancelled(a, since, 5000)
		check('admin_queue_cancel sends QUEUE_CANCELLED requeue:false', r.ok && !!n && n.content.requeue === false, `${r.text} ${JSON.stringify(n)}`)
		await removeTicket(a, ta)
	} finally {
		await setRanked(true)
		check('rankedEnabled restored', nkConfig().rankedEnabled === true)
		a.socket.close()
		b.socket.close()
		await sleep(300)
	}
	process.exitCode = summary('w5-ranked-switch') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
