// Live (W5): reproduces the duplicated my_runs pointers on the current stack
// (a private lobby whose players all leave mid-game is saved twice, see
// e052780) and shows what admin_runs_purge then leaves behind.
// Run: BMP_TEST_PREFIX=w5test_ node nakama/scripts/live/w5-dupe.live.mjs
import { check, lobbyWith, poll, psql, q, rpc, sleep, startGame, summary } from './lib.mjs'
import { player } from './w5-seed.live.mjs'

const pointers = (runId) => psql('nakama', `select user_id, key from storage where collection='my_runs' and key like ${q('%:' + runId)} order by key`)

async function main() {
	const [a, b] = [await player('a'), await player('b')]
	await lobbyWith([a, b])
	const { runId } = await startGame([a, b], {})
	// Leave through the lobby_leave RPC (a match signal), as the client does.
	console.log('LEAVE', (await rpc(b.token, 'lobby_leave', {})).text, (await rpc(a.token, 'lobby_leave', {})).text)
	await sleep(3000)
	const run = await poll(() => {
		const r = psql('nakama', `select value->>'status', value->>'endedAt' from storage where collection='match_runs' and key=${q(runId)}`)
		return r.length ? r[0] : null
	}, 15000)
	const ptrs = pointers(runId)
	console.log('RUN', runId, JSON.stringify(run), 'POINTERS', JSON.stringify(ptrs))
	const perUser = {}
	for (const [u] of ptrs) perUser[u] = (perUser[u] || 0) + 1
	check('abandoned lobby: one my_runs pointer per player (fails while e052780 is not live)', Object.values(perUser).every((n) => n === 1), JSON.stringify(perUser))
	console.log('OUT ' + JSON.stringify({ runId }))
	a.socket.close()
	b.socket.close()
	await sleep(300)
	process.exitCode = summary('w5-dupe') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
