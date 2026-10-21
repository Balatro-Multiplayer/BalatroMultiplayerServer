// Live: the admin RPCs ClaudeControl never drives (admin_ping, admin_profile_set,
// admin_player_get, admin_ratings_set, admin_ban_apply/lift, admin_account_delete),
// on throwaway device-auth accounts. Run: node nakama/scripts/live/admin.live.mjs
import {
	PREFIX,
	admin,
	check,
	connect,
	deviceAuth,
	lobbyWith,
	poll,
	psql,
	q,
	serverConfig,
	rpc,
	sleep,
	startSession,
	summary,
} from './lib.mjs'

const MOD = PREFIX + 'mod'
const MODE = PREFIX + 'mode'

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await startSession(p)
	return p
}

function storageRows(userId, collection) {
	return psql('nakama', `select key, value from storage where user_id=${q(userId)} and collection=${q(collection)}`)
}

async function main() {
	// --- admin_ping -------------------------------------------------------
	const ping = await admin('admin_ping', {})
	check('admin_ping answers {ok, express:true}', ping.ok && ping.body.ok === true && ping.body.express === true, ping.text)

	const a = await player('adm_a')
	const b = await player('adm_b')
	a.socket = await connect(a)
	b.socket = await connect(b)

	// --- admin_profile_set ------------------------------------------------
	let since = a.socket.mark()
	// The player view's privileges is the client's joker table (only joker
	// privileges show), so 'bean' (j_turtle_bean) makes the change visible.
	const set = await admin('admin_profile_set', { userId: a.userId, privileges: ['tester', 'bean'] })
	check('admin_profile_set privileges answers the player', set.ok && JSON.stringify(set.body.player.privileges) === '{"jokers":["j_turtle_bean"]}', set.text)
	const stored = storageRows(a.userId, 'player').find((r) => r[0] === 'profile')
	check('admin_profile_set lands in Nakama storage', stored && JSON.parse(stored[1]).privileges.includes('tester'), stored && stored[1].slice(0, 200))
	const upd = await a.socket.waitFor((i) => i.kind === 'notification' && i.code === 101, 5000, since)
	check('connected socket gets ACCOUNT_UPDATED (101)', !!upd, upd ? JSON.stringify(upd.content).slice(0, 200) : 'none in 5s')
	check('ACCOUNT_UPDATED carries the new privileges', upd && JSON.stringify(upd.content).includes('j_turtle_bean'))

	const joker = await admin('admin_profile_set', { userId: a.userId, preferredJoker: 'j_turtle_bean' })
	check('admin_profile_set privileged joker accepted', joker.ok && joker.body.player.preferredJoker === 'j_turtle_bean', joker.text)
	const lost = await admin('admin_profile_set', { userId: a.userId, privileges: [], preferredJoker: 'j_turtle_bean' })
	check('privileged joker refused once the privilege is gone', !lost.ok && lost.body.code === 3, lost.text.slice(0, 120))
	await admin('admin_profile_set', { userId: a.userId, preferredJoker: 'j_joker' })
	const badJoker = await admin('admin_profile_set', { userId: a.userId, preferredJoker: 'j_not_a_joker_h1' })
	check('admin_profile_set unknown joker refused (3)', !badJoker.ok && badJoker.body && badJoker.body.code === 3, badJoker.text)
	const noDiscord = await admin('admin_profile_set', { userId: a.userId, useDiscordName: true })
	check('admin_profile_set useDiscordName without Discord refused (9)', !noDiscord.ok && noDiscord.body.code === 9, noDiscord.text)
	const badDiscord = await admin('admin_profile_set', { userId: a.userId, discord: 'x' })
	check('admin_profile_set discord non-null refused', !badDiscord.ok && badDiscord.body.code === 3, badDiscord.text)
	const badPriv = await admin('admin_profile_set', { userId: a.userId, privileges: ['ok', 'bad priv!'] })
	check('admin_profile_set bad privilege name refused', !badPriv.ok && badPriv.body.code === 3, badPriv.text)
	const noUser = await admin('admin_profile_set', { userId: '11111111-1111-1111-1111-111111111111', privileges: [] })
	check('admin_profile_set unknown user -> NOT_FOUND (5)', !noUser.ok && noUser.body.code === 5, noUser.text)
	const unlink = await admin('admin_profile_set', { userId: a.userId, discord: null })
	check('admin_profile_set discord:null on an unlinked account is harmless', unlink.ok, unlink.text)
	await admin('admin_profile_set', { userId: a.userId, privileges: [] })

	// --- admin_player_get -------------------------------------------------
	const pg = await admin('admin_player_get', { userId: a.userId })
	check(
		'admin_player_get shows player, bans, lobby, online',
		pg.ok && pg.body.player.id === a.userId && 'bans' in pg.body && 'lobby' in pg.body && pg.body.online >= 1,
		pg.text.slice(0, 300),
	)
	const pgBad = await admin('admin_player_get', { userId: 'nope' })
	check('admin_player_get bad id refused (3)', !pgBad.ok && pgBad.body.code === 3, pgBad.text)

	// --- admin_ratings_set ------------------------------------------------
	const cfg = { body: serverConfig() }
	const season = cfg.body.season || 1
	const board = `${MOD}:${MODE}:${season}`
	const rec = { rating: 777, wins: 6, losses: 4, gamesPlayed: 10, seasonBest: 800, lastMatchAt: Date.now() }
	const rs = await admin('admin_ratings_set', {
		modId: MOD,
		mode: MODE,
		season,
		entries: [
			{ userId: a.userId, name: a.username, record: rec },
			{ userId: b.userId, name: b.username, record: { ...rec, rating: 650, gamesPlayed: 2 } },
		],
	})
	check('admin_ratings_set writes 2', rs.ok && rs.body.written === 2, rs.text)
	const ratingRow = storageRows(a.userId, 'ratings').find((r) => r[0] === board)
	check('admin_ratings_set stored the rating', ratingRow && JSON.parse(ratingRow[1]).rating === 777, ratingRow && ratingRow[1])
	const lb = psql('nakama', `select owner_id, score, subscore from leaderboard_record where leaderboard_id=${q(board)}`)
	check(
		'leaderboard has A (10 games) but not B (placement)',
		lb.some((r) => r[0] === a.userId && r[1] === '777' && r[2] === '6') && !lb.some((r) => r[0] === b.userId),
		JSON.stringify(lb),
	)
	const rg = await rpc(b.token, 'rating_get', { modId: MOD, mode: MODE, playerId: a.userId })
	check('rating_get (player) sees the overwritten rating', rg.ok && rg.body.rating === 777 && rg.body.isPlacement === false, rg.text)
	const lbg = await rpc(b.token, 'leaderboard_get', { modId: MOD, mode: MODE })
	check('leaderboard_get lists A', lbg.ok && lbg.body.entries.some((e) => e.playerId === a.userId && e.rating === 777), lbg.text.slice(0, 200))
	const clr = await admin('admin_ratings_set', {
		modId: MOD,
		mode: MODE,
		season,
		entries: [{ userId: a.userId, name: a.username, record: null }],
	})
	check('admin_ratings_set null clears', clr.ok && clr.body.cleared === 1, clr.text)
	check('cleared rating gone from storage', !storageRows(a.userId, 'ratings').some((r) => r[0] === board))
	check(
		'cleared rating gone from leaderboard',
		!psql('nakama', `select owner_id from leaderboard_record where leaderboard_id=${q(board)}`).some((r) => r[0] === a.userId),
	)
	for (const [label, body] of [
		['no modId', { mode: MODE, season, entries: [] }],
		['season 0', { modId: MOD, mode: MODE, season: 0, entries: [] }],
		['bad mode', { modId: MOD, mode: 'a b', season, entries: [] }],
		['bad record', { modId: MOD, mode: MODE, season, entries: [{ userId: a.userId, record: { rating: 'x' } }] }],
		['NaN-ish negative wins', { modId: MOD, mode: MODE, season, entries: [{ userId: a.userId, record: { ...rec, wins: -1 } }] }],
		['1001 entries', { modId: MOD, mode: MODE, season, entries: Array(1001).fill({ userId: a.userId, record: null }) }],
	]) {
		const r = await admin('admin_ratings_set', body)
		check(`admin_ratings_set refuses ${label}`, !r.ok && r.body && r.body.code === 3, r.text.slice(0, 150))
	}

	// --- bans: queue ------------------------------------------------------
	const ticket = (s) =>
		s.request({
			matchmaker_add: {
				min_count: 2,
				max_count: 2,
				query: `+properties.modId:${MOD} +properties.mode:${PREFIX}nobody`,
				string_properties: { modId: MOD, mode: PREFIX + 'nobody', kind: 'casual' },
			},
		})
	since = a.socket.mark()
	const qb = await admin('admin_ban_apply', { userId: a.userId, type: 'queue', banId: PREFIX + 'qban1', expiresAt: Date.now() + 3600e3, reason: 'h1 test' })
	check('admin_ban_apply queue', qb.ok && qb.body.bans.queue && qb.body.bans.queue.banId === PREFIX + 'qban1', qb.text)
	const banned = await a.socket.waitFor((i) => i.kind === 'notification' && i.code === 102, 5000, since)
	check('BANNED (102) pushed for a queue ban', banned && banned.content.banType === 'queue', banned && JSON.stringify(banned.content))
	let t = await ticket(a.socket)
	check('queue-banned player refused at matchmaker_add', t.error && /banned from matchmaking/.test(t.error.message), JSON.stringify(t.error || t).slice(0, 200))
	const ql = await admin('admin_ban_lift', { userId: a.userId, banId: PREFIX + 'qban1' })
	check('admin_ban_lift queue', ql.ok && !ql.body.bans.queue, ql.text)
	t = await ticket(a.socket)
	check('after lift, matchmaker_add accepted', t.matchmaker_ticket && t.matchmaker_ticket.ticket, JSON.stringify(t).slice(0, 200))
	if (t.matchmaker_ticket) await a.socket.request({ matchmaker_remove: { ticket: t.matchmaker_ticket.ticket } })
	const expired = await admin('admin_ban_apply', { userId: a.userId, type: 'queue', banId: PREFIX + 'qban_exp', expiresAt: Date.now() - 1000, reason: '' })
	t = await ticket(a.socket)
	check('an already-expired queue ban does not refuse', expired.ok && t.matchmaker_ticket, JSON.stringify(t).slice(0, 200))
	if (t.matchmaker_ticket) await a.socket.request({ matchmaker_remove: { ticket: t.matchmaker_ticket.ticket } })
	await admin('admin_ban_lift', { userId: a.userId, banId: PREFIX + 'qban_exp' })
	for (const [label, body] of [
		['bad type', { userId: a.userId, type: 'forever', banId: 'x' }],
		['no banId', { userId: a.userId, type: 'chat' }],
		['bad expiresAt', { userId: a.userId, type: 'chat', banId: 'x', expiresAt: 'soon' }],
		['unknown user', { userId: '11111111-1111-1111-1111-111111111111', type: 'chat', banId: 'x' }],
	]) {
		const r = await admin('admin_ban_apply', body)
		check(`admin_ban_apply refuses ${label}`, !r.ok && r.body && (r.body.code === 3 || r.body.code === 5), r.text.slice(0, 150))
	}
	const liftUnknown = await admin('admin_ban_lift', { userId: a.userId, banId: 'never-issued' })
	check('admin_ban_lift of an unknown banId is a no-op', liftUnknown.ok, liftUnknown.text)

	// --- bans: chat (needs chatEnabled for a live send) ---------------------
	const cb = await admin('admin_ban_apply', { userId: a.userId, type: 'chat', banId: PREFIX + 'cban1', expiresAt: null, reason: 'h1 chat' })
	check('admin_ban_apply chat (permanent)', cb.ok && cb.body.bans.chat && cb.body.bans.chat.expiresAt === null, cb.text)
	const lob = await lobbyWith([a, b], { modId: MOD })
	const chat = await rpc(a.token, 'chat_send', { message: 'hello' })
	const chatOn = cfg.body.chatEnabled === true
	if (chatOn) check('chat-banned player refused at chat_send', !chat.ok && /banned from chat/.test(chat.text), chat.text)
	else
		check(
			'chat_send while chat is globally off: refused before the ban check (chat-ban live send BLOCKED: chatEnabled=false)',
			!chat.ok && /turned off/.test(chat.text),
			chat.text,
		)
	await admin('admin_ban_lift', { userId: a.userId, banId: PREFIX + 'cban1' })

	// --- bans: account ------------------------------------------------------
	const lobbyBefore = await admin('admin_lobby_get', { code: lob.code })
	since = b.socket.mark()
	const ab = await admin('admin_ban_apply', { userId: b.userId, type: 'account', banId: PREFIX + 'aban1', expiresAt: null, reason: 'h1 acct' })
	check('admin_ban_apply account', ab.ok && ab.body.bans.account, ab.text)
	const bClosed = await b.socket.waitFor((i) => i.kind === 'closed', 5000, since)
	check('account ban drops the banned socket', !!bClosed, bClosed ? 'code ' + bClosed.code : 'still open')
	const lobbyAfter = await admin('admin_lobby_get', { code: lob.code })
	check(
		'account ban takes the player out of their lobby',
		lobbyBefore.body.lobby.players.length === 2 && lobbyAfter.ok && lobbyAfter.body.lobby.players.length === 1,
		JSON.stringify(lobbyAfter.body && lobbyAfter.body.lobby && lobbyAfter.body.lobby.players),
	)
	const relog = await deviceAuth('adm_b')
	check('banned account cannot log in', !!relog.error, relog.error ? relog.error.text.slice(0, 150) : 'logged in!')
	const oldTok = await rpc(b.token, 'session_init', { steamName: b.username })
	check('banned account old session token refused', !oldTok.ok, `${oldTok.status} ${oldTok.text.slice(0, 120)}`)
	const al = await admin('admin_ban_lift', { userId: b.userId, banId: PREFIX + 'aban1' })
	const relog2 = await deviceAuth('adm_b')
	check('after lift the account logs in again', al.ok && !relog2.error && relog2.userId === b.userId, relog2.error ? relog2.error.text : '')
	await admin('admin_lobby_close', { code: lob.code })

	// --- admin_account_delete -----------------------------------------------
	const c = await player('adm_c')
	c.socket = await connect(c)
	await admin('admin_ratings_set', {
		modId: MOD,
		mode: MODE,
		season,
		entries: [{ userId: c.userId, name: c.username, record: rec }],
	})
	const lob2 = await lobbyWith([c, a], { modId: MOD })
	const beforeCollections = psql('nakama', `select collection, count(*) from storage where user_id=${q(c.userId)} group by 1`)
	since = a.socket.mark()
	const del = await admin('admin_account_delete', { userId: c.userId })
	check('admin_account_delete answers deleted', del.ok && del.body.deleted === true, del.text)
	const left = await a.socket.waitFor((i) => i.kind === 'data' && i.op === 101 && i.data.playerId === c.userId, 5000, since)
	check('deleted player leaves their lobby (others told)', !!left, left ? left.data.type : 'no event')
	check('users row gone', psql('nakama', `select count(*) from users where id=${q(c.userId)}`)[0][0] === '0')
	const after = psql('nakama', `select collection, count(*) from storage where user_id=${q(c.userId)} group by 1`)
	check('all of its storage is gone', after.length === 0, `before ${JSON.stringify(beforeCollections)} after ${JSON.stringify(after)}`)
	const lbAfter = psql('nakama', `select count(*) from leaderboard_record where owner_id=${q(c.userId)}`)
	check('its leaderboard records are gone', lbAfter[0][0] === '0', JSON.stringify(lbAfter))
	const oldToken = await rpc(c.token, 'rating_get', { modId: MOD, mode: MODE })
	console.log(`  info: deleted account's old token on rating_get -> ${oldToken.status} ${oldToken.text.slice(0, 120)}`)
	const oldInit = await rpc(c.token, 'session_init', { steamName: c.username })
	console.log(`  info: deleted account's old token on session_init -> ${oldInit.status} ${oldInit.text.slice(0, 120)}`)
	const oldCreate = await rpc(c.token, 'lobby_create', { modId: MOD })
	console.log(`  info: deleted account's old token on lobby_create -> ${oldCreate.status} ${oldCreate.text.slice(0, 160)}`)
	if (oldCreate.ok) await admin('admin_lobby_close', { code: oldCreate.body.code })
	const relogC = await deviceAuth('adm_c', { create: false })
	check('deleted account cannot log in (create=false)', !!relogC.error, relogC.error ? `${relogC.error.status}` : 'logged in')
	const relogC2 = await deviceAuth('adm_c', { create: true })
	check('same device with create=true makes a NEW account', !relogC2.error && relogC2.userId !== c.userId, relogC2.userId)
	const del2 = await admin('admin_account_delete', { userId: c.userId })
	check('admin_account_delete of a gone account -> NOT_FOUND', !del2.ok && del2.body.code === 5, del2.text)
	// The lobby C was in: still open with A?
	const lob2View = await admin('admin_lobby_get', { code: lob2.code })
	console.log(`  info: lobby after delete: ${lob2View.text.slice(0, 200)}`)
	await admin('admin_lobby_close', { code: lob2.code })
	a.socket.close()
	b.socket.close()
	c.socket.close()
	await sleep(300)
	process.exitCode = summary('admin.live') ? 1 : 0
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
