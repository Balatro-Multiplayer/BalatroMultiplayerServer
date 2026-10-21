// Live: avatar unlocks and achievements (nakama/src/achievements,
// nakama/src/shared/avatars). Checks:
//  - avatar_catalog lists all 63 avatars with locks and goals
//  - profile_set_joker refuses a locked avatar and takes a default one
//  - admin_avatars_for answers by account and by privileges (staff: Mime + Showman)
//  - admin_progress_set (testing servers) sets a player just short of a goal
//  - with achievements on: a real 2-player game (> 2 minutes, logs with hands)
//    crosses the goals, AVATAR_UNLOCKED (107) arrives, the avatar becomes
//    pickable; meeting a player showing Showman earns Showman; the same run
//    is never counted twice
//  - admin_avatars_reset: a dry run counts, a real run resets the joker and
//    deletes progress
//
// The game part switches achievementsEnabled on through admin_config_set and
// the reset part changes every player, so both only run against a throwaway
// Nakama: set AVATARS_LIVE_THROWAWAY=1 with BMP_NAKAMA_URL pointing at it.
// Against the shared local stack only the read and per-player checks run.
// Run: AVATARS_LIVE_THROWAWAY=1 BMP_NAKAMA_URL=http://127.0.0.1:27350 node nakama/scripts/live/achievements.live.mjs
import { NAKAMA, admin, check, connect, deviceAuth, lobbyWith, rpc, sendLog, sleep, startGame, startSession, summary } from './lib.mjs'

const THROWAWAY = process.env.AVATARS_LIVE_THROWAWAY === '1'
const SHARED_STACK = /:7350\/?$/.test(NAKAMA)
const AVATAR_UNLOCKED = 107
// eligibility.ts MIN_GAME_MS is 2 minutes.
const GAME_MS = 125_000

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	const init = await startSession(p)
	if (!init.ok) throw new Error(`session_init ${name}: ${init.text}`)
	p.init = init.body
	return p
}

const avatarOf = (catalog, id) => catalog.avatars.find((a) => a.id === id)

// A played hand as MPAPI logs it: play [indices, first-seen playing cards].
const hand = (t, id) => [t, 'play', [[1, 2], [[-id, 'pc', 'Hearts', 'King'], [-(id + 1), 'pc', 'Spades', '10']]]]
const gameLog = (deck) => [
	[0, 'lobby_info', { decks: [deck], ruleset: 'ruleset_mp_balanced', gamemode: 'gamemode_mp_attrition' }],
	[1, 'run_info', { deck, seed: 'LIVE', stake: 1 }],
	hand(10_000, 10),
	hand(20_000, 12),
	hand(30_000, 14),
	hand(40_000, 16),
	[50_000, 'end', { result: 'win' }],
]

async function readChecks(a, stamp) {
	const catalog = await rpc(a.token, 'avatar_catalog', {})
	check('avatar_catalog answers', catalog.ok, catalog.text.slice(0, 160))
	if (!catalog.ok) return
	const c = catalog.body
	check('catalog lists all 63 avatars', c.avatars.length === 63, `${c.avatars.length}`)
	check('a default avatar is unlocked with no goal', avatarOf(c, 'j_jolly').unlocked && avatarOf(c, 'j_jolly').goal === null)
	const baron = avatarOf(c, 'j_baron')
	check('Baron is locked with its goal (win 1 game)', !baron.unlocked && baron.goal && baron.goal.key === 'wins' && baron.goal.threshold === 1, JSON.stringify(baron))
	check('catalog says whether achievements are on', typeof c.enabled === 'boolean', `enabled=${c.enabled}`)

	const locked = await rpc(a.token, 'profile_set_joker', { preferredJoker: 'j_baron' })
	check('profile_set_joker refuses a locked avatar', !locked.ok, `${locked.status}`)
	const reserved = await rpc(a.token, 'profile_set_joker', { preferredJoker: 'j_blueprint' })
	check('profile_set_joker refuses a reserved avatar', !reserved.ok, `${reserved.status}`)
	const free = await rpc(a.token, 'profile_set_joker', { preferredJoker: 'j_jolly' })
	check('profile_set_joker takes a default avatar', free.ok && free.body.player.preferredJoker === 'j_jolly', free.text.slice(0, 160))

	const byAccount = await admin('admin_avatars_for', { userId: a.userId })
	check('admin_avatars_for answers by account', byAccount.ok && byAccount.body.selected === 'j_jolly' && byAccount.body.jokers.length === 11, byAccount.text.slice(0, 160))
	const byPrivileges = await admin('admin_avatars_for', { privileges: ['staff'] })
	check(
		'admin_avatars_for by privileges: staff gets Mime and Showman',
		byPrivileges.ok && byPrivileges.body.jokers.includes('j_mime') && byPrivileges.body.jokers.includes('j_ring_master'),
		byPrivileges.text.slice(0, 160),
	)
	const unknown = await admin('admin_avatars_for', { userId: '00000000-0000-4000-8000-00000000dead' })
	check('admin_avatars_for: an unknown player is not found', unknown.status === 404, `${unknown.status}`)
	const asPlayer = await rpc(a.token, 'admin_avatars_for', { userId: a.userId })
	check('admin_avatars_for is server-only', !asPlayer.ok, `${asPlayer.status}`)
	const setAsPlayer = await rpc(a.token, 'admin_progress_set', { userId: a.userId, counters: { wins: 100 } })
	check('admin_progress_set is server-only', !setAsPlayer.ok, `${setAsPlayer.status}`)
}

async function gameChecks(a, b) {
	// a: one game short of Swashbuckler (5 games) and not yet a winner (Baron).
	const near = await admin('admin_progress_set', { userId: a.userId, reset: true, counters: { games: 4 } })
	check('admin_progress_set sets a player just short of a goal', near.ok && near.body.progress.counters.games === 4, near.text.slice(0, 160))
	await admin('admin_progress_set', { userId: b.userId, reset: true })
	// b shows Showman (staff), so a meets it.
	const staff = await admin('admin_profile_set', { userId: b.userId, privileges: ['staff'], preferredJoker: 'j_ring_master' })
	check('a staff player may show Showman', staff.ok, staff.text.slice(0, 160))

	a.socket = await connect(a)
	b.socket = await connect(b)
	await lobbyWith([a, b])
	const { runId } = await startGame([a, b], {})
	await sendLog(a.socket, runId, gameLog('Blue Deck'))
	await sendLog(b.socket, runId, gameLog('Red Deck'))
	console.log(`  info: game ${runId} started; waiting ${GAME_MS / 1000}s so it counts`)
	await sleep(GAME_MS)
	const mark = a.socket.inbox.length
	const placements = [{ playerId: a.userId, place: 1 }, { playerId: b.userId, place: 2 }]
	const ra = await a.socket.ask('mpapi_report_result', { placements })
	const rb = await b.socket.ask('mpapi_report_result', { placements })
	check('both report the result', ra.ok && rb.ok, JSON.stringify([ra, rb]))

	const note = await a.socket
		.waitFor((i) => i.kind === 'notification' && i.code === AVATAR_UNLOCKED, 15000, mark)
		.catch(() => null)
	const earned = note ? note.content.avatarIds : []
	check(
		'AVATAR_UNLOCKED names what the game earned (Baron, Swashbuckler, Showman)',
		!!note && ['j_baron', 'j_swashbuckler', 'j_ring_master'].every((id) => earned.includes(id)) && note.content.runId === runId,
		JSON.stringify(note && note.content),
	)
	const catalog = await rpc(a.token, 'avatar_catalog', {})
	check('earned avatars show as unlocked', catalog.ok && avatarOf(catalog.body, 'j_baron').unlocked && avatarOf(catalog.body, 'j_swashbuckler').unlocked)
	const picked = await rpc(a.token, 'profile_set_joker', { preferredJoker: 'j_baron' })
	check('an earned avatar can be picked', picked.ok && picked.body.player.preferredJoker === 'j_baron', picked.text.slice(0, 160))
	const progress = await admin('admin_progress_set', { userId: a.userId })
	const p = progress.body && progress.body.progress
	check('the game counted once, with its hands and deck', !!p && p.counters.games === 5 && p.counters.wins === 1 && p.counters.hands === 4 && p.deckGames.b_blue === 1, JSON.stringify(p && { counters: p.counters, deckGames: p.deckGames }))
	return runId
}

async function resetChecks(a) {
	const dry = await admin('admin_avatars_reset', { dryRun: true })
	check('admin_avatars_reset dry run counts', dry.ok && dry.body.dryRun === true && dry.body.checked >= 1, dry.text.slice(0, 200))
	let cursor = ''
	let rounds = 0
	let resetTotal = 0
	do {
		const page = await admin('admin_avatars_reset', { cursor })
		if (!page.ok) {
			check('admin_avatars_reset pages through', false, page.text.slice(0, 200))
			return
		}
		resetTotal += page.body.jokersReset
		cursor = page.body.cursor
		rounds++
	} while (cursor && rounds < 1000)
	check('admin_avatars_reset finishes', cursor === '', `${rounds} pages, ${resetTotal} jokers reset`)
	const after = await admin('admin_avatars_for', { userId: a.userId })
	check('the reset put the earned joker back to the default', after.ok && after.body.selected === 'j_joker', after.text.slice(0, 160))
	const progress = await admin('admin_progress_set', { userId: a.userId })
	check('the reset deleted progress', progress.ok && progress.body.progress.counters.games === 0, progress.text.slice(0, 160))
	const bad = await admin('admin_avatars_reset', { cursor: 'nope' })
	check('admin_avatars_reset refuses a bad cursor', bad.status === 400, `${bad.status}`)
}

async function main() {
	const stamp = Date.now().toString(36)
	const a = await player(`av_${stamp}_a`)
	const b = await player(`av_${stamp}_b`)
	await readChecks(a, stamp)

	if (!THROWAWAY || SHARED_STACK) {
		console.log('  info: not a throwaway Nakama (AVATARS_LIVE_THROWAWAY=1, not :7350): skipping the game and reset checks')
		return
	}
	const wasEnabled = a.init.serverConfig && a.init.serverConfig.achievementsEnabled === true
	const on = await admin('admin_config_set', { achievementsEnabled: true })
	check('achievements switched on (throwaway server)', on.ok, on.text.slice(0, 160))
	try {
		await gameChecks(a, b)
	} finally {
		await admin('admin_config_set', { achievementsEnabled: wasEnabled })
	}
	await resetChecks(a)
}

main()
	.catch((e) => {
		check('no unexpected error', false, e.stack || String(e))
	})
	.finally(() => {
		process.exit(summary('achievements') ? 1 : 0)
	})
