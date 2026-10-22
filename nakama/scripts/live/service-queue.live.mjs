// Live: the moderator service queue end to end. Real items of every type are
// made through the real paths (Nakama -> mirror/relay -> Express), their
// evidence is read back through GET /api/webadmin/service-queue/:id, and
// every action runs as a moderator and as an admin, checking the effects in
// Postgres and Nakama: bans applied and lifted, the WARNED (109) notification,
// results overturned and games voided with their ratings rebuilt, the source
// rows kept in step, claims, reopen and the audit trail.
//
//   node nakama/scripts/live/service-queue.live.mjs            # everything but integrity
//   node nakama/scripts/live/service-queue.live.mjs integrity  # integrity items only
//
// The default run needs the moderation service up (flagged chat goes through
// it) and takes ~3 minutes (the forfeit waits out the real 120s grace). The
// integrity run needs api-green started with DEV_FAKE_LAUNCHER_STRATEGY=true
// (HOWTO.md); it patches integrityEnforced off for its ranked queue. Both
// turn chat on only for their run and put the server config back as found.
// Staff logins are throwaway players rows (as webadmin.live.mjs makes them).
// service-queue-seed.live.mjs reuses the scenarios to leave open items behind.
import { pathToFileURL } from 'node:url'
import {
	PREFIX,
	admin,
	check,
	connect,
	deviceAuth,
	express,
	lobbyWith,
	poll,
	psql,
	q,
	rpc,
	sendLog,
	serverConfig,
	sleep,
	startGame,
	startSession,
	summary,
	webJwt,
} from './lib.mjs'
import { hostFirst, matchmake } from './mirror.live.mjs'

const MOD = PREFIX + 'mod'
const W = '/api/webadmin'
const SQ = `${W}/service-queue`
const stamp = Date.now().toString(36)
const NOTIFY_CHALLENGE = 100
const NOTIFY_WARNED = 109

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function staffRow(name, privileges) {
	psql(
		'bmp',
		`insert into players (steam_name, privileges) select ${q(name)}, ${q(`{${privileges.join(',')}}`)}::text[]
		  where not exists (select 1 from players where steam_name = ${q(name)})`,
	)
	const id = psql('bmp', `select id from players where steam_name = ${q(name)} order by created_at limit 1`)[0][0]
	return { id, token: webJwt(id, name) }
}

export function pgId(nakamaUserId) {
	const r = psql('bmp', `select id from players where nakama_user_id = ${q(nakamaUserId)}`)
	return r.length ? r[0][0] : null
}

export async function player(name) {
	const p = await deviceAuth(`sq_${stamp}_${name}`)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await startSession(p)
	const tos = await rpc(p.token, 'tos_accept', { chatEligible: true })
	if (!tos.ok) throw new Error(`tos_accept ${name}: ${tos.text}`)
	p.socket = await connect(p)
	return p
}

export const placementsOf = (order) => order.map((p, i) => ({ playerId: p.userId, place: i + 1 }))

const gameEnded = (p, since, timeoutMs = 15000) =>
	p.socket.waitFor((x) => x.kind === 'data' && x.op === 101 && x.data.type === 'game_ended', timeoutMs, since)

// The queue item for a source, once the mirror/relay has raised it.
export async function itemFor(itemType, sourceId, timeoutMs = 40000) {
	const row = await poll(() => {
		const r = psql('bmp', `select id from service_queue_items where item_type = ${q(itemType)} and source_id = ${q(sourceId)}`)
		return r.length ? Number(r[0][0]) : null
	}, timeoutMs)
	return row || null
}

const itemRow = (id) => {
	const r = psql('bmp', `select status, resolution_action, claimed_by, context::text from service_queue_items where id = ${Number(id)}`)
	// psql prints NULL as ''.
	return r.length ? { status: r[0][0], resolutionAction: r[0][1] || null, claimedBy: r[0][2] || null, context: JSON.parse(r[0][3] || '{}') } : null
}

const sourceStatus = (table, id) => {
	const r = psql('bmp', `select status from ${table} where id = ${Number(id)}`)
	return r.length ? r[0][0] : null
}

const ratingsOf = (ids, gameMode) =>
	Object.fromEntries(
		psql(
			'bmp',
			`select player_id, wins, losses, games_played from matchmaking_ratings
			  where player_id in (${ids.map(q).join(',')}) and mod_id = ${q(MOD)} and game_mode = ${q(gameMode)}`,
		).map((r) => [r[0], { wins: Number(r[1]), losses: Number(r[2]), games: Number(r[3]) }]),
	)

async function nakamaBans(nakamaUserId) {
	const g = await admin('admin_player_get', { userId: nakamaUserId })
	return g.ok ? g.body.bans || {} : null
}

// Polls Nakama until fn(bans) holds.
const bansUntil = (nakamaUserId, fn, timeoutMs = 8000) =>
	poll(async () => {
		const bans = await nakamaBans(nakamaUserId)
		return bans && fn(bans) ? bans : null
	}, timeoutMs, 500)

// ---------------------------------------------------------------------------
// The queue's HTTP surface
// ---------------------------------------------------------------------------

const detail = (id, staff) => express('GET', `${SQ}/${id}`, { token: staff.token })
const act = (id, action, staff, body = {}) => express('POST', `${SQ}/${id}/actions/${action}`, { token: staff.token, body })
const claim = (id, staff) => express('POST', `${SQ}/${id}/claim`, { token: staff.token })
const release = (id, staff, force = false) => express('DELETE', `${SQ}/${id}/claim${force ? '?force=1' : ''}`, { token: staff.token })
const actionsOf = (res) => (res.ok ? res.body.allowedActions.map((a) => a.action) : [])
const presetsOf = (res, action) => ((res.ok && res.body.allowedActions.find((a) => a.action === action)) || {}).presets

function refused(label, res, status, code) {
	check(`${label}: ${status} ${code}`, res.status === status && res.body && res.body.code === code, `${res.status} ${res.text.slice(0, 160)}`)
}

function acted(label, res, action) {
	check(
		`${label}: 200, item ${action === 'note' || action === 'unban' || action === 'reopen' ? '' : 'resolved by '}${action}`,
		res.ok && res.body.action === action,
		`${res.status} ${res.text.slice(0, 200)}`,
	)
	return res.ok ? res.body : null
}

// ---------------------------------------------------------------------------
// Config: chat on for the run, everything put back as found
// ---------------------------------------------------------------------------

const BASELINE_KEYS = [
	'season',
	'chatEnabled',
	'testingMode',
	'rankedEnabled',
	'groupQueueEnabled',
	'integrityEnforced',
	'casualQueueEnabled',
	'queueAllowedModIds',
	'achievementsEnabled',
	'lobbyCreationEnabled',
	'queueAllowedModIdsExtra',
]

export function configSnapshot() {
	const config = serverConfig()
	return Object.fromEntries(BASELINE_KEYS.filter((k) => k in config).map((k) => [k, config[k]]))
}

export async function restoreConfig(snapshot) {
	const r = await admin('admin_config_set', snapshot)
	const now = configSnapshot()
	check('config restored as found', r.ok && JSON.stringify(now) === JSON.stringify(snapshot), JSON.stringify(now))
}

// ---------------------------------------------------------------------------
// Scenarios that make items
// ---------------------------------------------------------------------------

// A matchmade RANKED game where one player drops past the 120s grace and
// comes back: a forfeit_reconciliation item, the game rated as partial.
export async function forfeitGame() {
	const [f1, f2] = [await player('f1'), await player('f2')]
	const mode = `${PREFIX}sqf_${stamp}`
	const { code } = await matchmake([f1, f2], mode, 'ranked')
	const [host, other] = await hostFirst(code, [f1, f2])
	const runId = (await startGame([host, other], {})).runId
	other.socket.close()
	const left = await host.socket.waitFor(
		(x) => x.kind === 'data' && x.op === 101 && x.data.type === 'player_left' && JSON.stringify(x.data).includes(other.userId),
		200000,
	)
	check('forfeit: dropped player removed after the grace', !!left)
	await startSession(other)
	const since = host.socket.mark()
	await host.socket.ask('mpapi_report_result', { placements: placementsOf([host, other]) })
	const end = await gameEnded(host, since)
	check('forfeit: lone report settles it as partial', end && end.data.data.status === 'partial', JSON.stringify(end && end.data.data))
	host.socket.sendOp(1, {})
	const flag = await poll(() => {
		const r = psql(
			'bmp',
			`select f.id from forfeit_reconciliation_flags f join players p on p.id = f.player_id
			  where p.nakama_user_id = ${q(other.userId)} and f.match_id = ${q(runId)}`,
		)
		return r.length ? r[0][0] : null
	}, 40000)
	const itemId = flag ? await itemFor('forfeit_reconciliation', String(flag)) : null
	check('forfeit: item raised for the reconciliation flag', !!itemId, `flag ${flag}`)
	host.socket.close()
	return { itemId, flagId: flag, runId, gameMode: 'ranked:' + mode, host, other }
}

// Sends a chat line; true when posted, the error text when refused.
async function say(p, message) {
	const r = await rpc(p.token, 'chat_send', { message })
	await sleep(1100) // the lobby's chat rate limit
	return r.ok ? true : r.text
}

const ABUSE = [
	'kill yourself you worthless piece of garbage',
	'you are a disgusting subhuman, go die',
	'i hope your whole family dies you retard',
]

// The private lobby: a game where a trips the elapsed-time gate and b's log
// is tampered (2 flagged players, 2 anti_cheat items), with the result
// disputed (a private match_conflict); then lobby chat (b's abusive line is
// blocked and flagged) and a's report against b.
export async function privateLobby(a, b) {
	const lobby = await lobbyWith([a, b], { modId: MOD })
	const runId = (await startGame([a, b], { stake: 1 })).runId
	const hands = Array.from({ length: 20 }, (_, i) => [10 + i, 'hand_result', [100 * (i + 1)]])
	await sendLog(a.socket, runId, [[1, 'start', { deck: 'b_red' }], ...hands, [90, 'end', { won: true }]])
	await sendLog(b.socket, runId, [[1, 'start', { deck: 'b_blue' }], [2, 'blind', ['bl_small']]], { tamper: true })
	await sleep(500)
	const since = a.socket.mark()
	await a.socket.ask('mpapi_report_result', { placements: placementsOf([a, b]) })
	await b.socket.ask('mpapi_report_result', { placements: placementsOf([b, a]) })
	const end = await gameEnded(a, since)
	check('private: 1-vs-1 disagreement is disputed, the host (a) recorded', end && end.data.data.status === 'disputed', JSON.stringify(end && end.data.data))
	const run = JSON.parse(psql('nakama', `select value from storage where collection='match_runs' and key=${q(runId)}`)[0][0])
	check(
		'private: a flagged elapsed_time_gate, b hash_mismatch',
		run.flags && run.flags[a.userId] === 'elapsed_time_gate' && run.flags[b.userId] === 'hash_mismatch',
		JSON.stringify(run.flags),
	)
	await poll(() => psql('bmp', `select 1 from lobby_runs where id = ${q(runId)}`).length > 0, 40000)
	const [pa, pb] = [pgId(a.userId), pgId(b.userId)]
	check('private: both players have players rows', !!pa && !!pb)

	const acA = await itemFor('anti_cheat', `${runId}:${pa}`)
	const acB = await itemFor('anti_cheat', `${runId}:${pb}`)
	check('private: an anti_cheat item per flagged player, keyed run:player', !!acA && !!acB, `${acA} ${acB}`)
	const conflictId = psql('bmp', `select id from match_result_conflicts where match_id = ${q(runId)}`)
	const conflict = conflictId.length ? await itemFor('match_conflict', conflictId[0][0]) : null
	check('private: the disputed game is filed as a match_conflict item', !!conflict, JSON.stringify(conflictId))
	check('private: items carry lobbyKind private', [acA, acB, conflict].every((id) => id && itemRow(id).context.lobbyKind === 'private'))

	// Chat: two clean lines, then b's abusive one (blocked, flagged).
	const posted = [await say(a, 'gl hf'), await say(b, 'you too')]
	check('chat: clean lines posted', posted.every((x) => x === true), JSON.stringify(posted))
	let abusive = null
	for (const text of ABUSE) {
		const r = await say(b, text)
		if (r !== true && /blocked/i.test(r)) {
			abusive = text
			break
		}
		if (r !== true) {
			check('chat: moderation reachable (is moderation-1 up?)', false, r.slice(0, 160))
			break
		}
	}
	check('chat: an abusive line was blocked by moderation', !!abusive)
	const flaggedId = abusive
		? await poll(() => {
				const r = psql('bmp', `select id from flagged_messages where player_id = ${q(pb)} and message = ${q(abusive)}`)
				return r.length ? r[0][0] : null
			}, 40000)
		: null
	const flagged = flaggedId ? await itemFor('flagged_chat', String(flaggedId)) : null
	check('chat: flagged_chat item raised, lobbyKind private', !!flagged && itemRow(flagged).context.lobbyKind === 'private', `flag ${flaggedId}`)

	const rep = await rpc(a.token, 'report_submit', { reportedUserId: b.userId, type: 'chat_abuse', message: 'sq live: abusive' })
	check('report (private): filed', rep.ok && typeof rep.body.reportId === 'number', rep.text.slice(0, 160))
	const report = rep.ok ? await itemFor('report', String(rep.body.reportId), 15000) : null
	check('report (private): item raised with lobbyKind private', !!report && itemRow(report).context.lobbyKind === 'private')
	return { lobby, runId, pa, pb, acA, acB, conflict, conflictId: conflictId[0]?.[0], flagged, flaggedId, abusive, report, reportId: rep.body?.reportId }
}

// A matchmade RANKED game, disputed 1-vs-1 (the host's result recorded), and
// c's report against d from that lobby.
export async function rankedDispute(c, d) {
	const mode = `${PREFIX}sqr_${stamp}`
	const { code } = await matchmake([c, d], mode, 'ranked')
	const [host, other] = await hostFirst(code, [c, d])
	const runId = (await startGame([host, other], {})).runId
	const since = host.socket.mark()
	await host.socket.ask('mpapi_report_result', { placements: placementsOf([host, other]) })
	await other.socket.ask('mpapi_report_result', { placements: placementsOf([other, host]) })
	const end = await gameEnded(host, since)
	check('ranked: 1-vs-1 disagreement is disputed', end && end.data.data.status === 'disputed', JSON.stringify(end && end.data.data))
	// Reported once mirrored: a device player's players row comes from the
	// mirror (a Steam player's from session_init), and a report keeps the
	// Nakama id of a player who has none.
	await poll(() => psql('bmp', `select 1 from lobby_runs where id = ${q(runId)}`).length > 0, 40000)
	const rep = await rpc(host.token, 'report_submit', { reportedUserId: other.userId, type: 'cheating', message: 'sq live: ranked' })
	check('report (ranked): filed', rep.ok, rep.text.slice(0, 160))
	for (const p of [c, d]) p.socket.sendOp(1, {})
	const conflictId = await poll(() => {
		const r = psql('bmp', `select id from match_result_conflicts where match_id = ${q(runId)}`)
		return r.length ? r[0][0] : null
	}, 40000)
	const conflict = conflictId ? await itemFor('match_conflict', conflictId) : null
	check('ranked: match_conflict item, lobbyKind ranked', !!conflict && itemRow(conflict).context.lobbyKind === 'ranked')
	const report = rep.ok ? await itemFor('report', String(rep.body.reportId), 15000) : null
	check('report (ranked): item raised with lobbyKind ranked', !!report && itemRow(report).context.lobbyKind === 'ranked')
	return { runId, host, other, conflict, conflictId, report, reportId: rep.body?.reportId, gameMode: 'ranked:' + mode }
}

// ---------------------------------------------------------------------------
// Checks per type
// ---------------------------------------------------------------------------

async function antiCheatChecks(P, mod, adm, b) {
	const dA = await detail(P.acA, mod)
	const ev = dA.ok ? dA.body.evidence : {}
	check(
		'anti_cheat evidence: elapsed gate explained with its numbers',
		ev.flag && ev.flag.reason === 'elapsed_time_gate' && ev.flag.hands === 20 && ev.flag.minimumMs === 60000 && ev.flag.elapsedMs < 60000,
		JSON.stringify(ev.flag),
	)
	check('anti_cheat evidence: run, player, log check match', ev.runId === P.runId && ev.playerId === P.pa && ev.check === 'match', `${ev.check}`)
	check('anti_cheat evidence: the other flagged player listed', Array.isArray(ev.otherFlaggedPlayers) && ev.otherFlaggedPlayers.includes(P.pb), JSON.stringify(ev.otherFlaggedPlayers))
	check('anti_cheat evidence: Nakama run (admin_run_get) and replay', ev.run && ev.run.run.runId === P.runId && ev.replay && ev.replay.logs.length === 2)
	check('anti_cheat evidence: log events stripped from the page', ev.run && Object.values(ev.run.logs).every((l) => l.events === undefined))
	const dB = await detail(P.acB, mod)
	check('anti_cheat evidence: hash mismatch for b', dB.ok && dB.body.evidence.flag.reason === 'hash_mismatch' && dB.body.evidence.check === 'mismatch', dB.ok ? JSON.stringify(dB.body.evidence.flag) : dB.text)
	check('anti_cheat: moderator may not void', !actionsOf(dA).includes('void') && actionsOf(dA).includes('queue_ban'))

	refused('anti_cheat: moderator void', await act(P.acA, 'void', mod), 403, 'forbidden')
	refused('anti_cheat: moderator account_ban', await act(P.acB, 'account_ban', mod, { duration: '7d', reason: 'x' }), 403, 'forbidden')
	refused('anti_cheat: chat_mute is not for this type', await act(P.acB, 'chat_mute', mod, { duration: '24h' }), 400, 'not_for_type')
	refused('anti_cheat: bad duration', await act(P.acB, 'queue_ban', mod, { duration: 'forever' }), 400, 'invalid_body')
	const qb = acted('anti_cheat: moderator queue_ban 7d on b', await act(P.acB, 'queue_ban', mod, { duration: '7d', reason: 'sq live hash' }), 'queue_ban')
	const ban = qb && qb.effects.ban
	check('queue_ban: Postgres ban row, ~7 days, delivered to Nakama', ban && ban.banType === 'queue' && qb.effects.delivered === true && Math.abs(new Date(ban.expiresAt) - Date.now() - 7 * 864e5) < 60000, JSON.stringify(qb && qb.effects))
	check('queue_ban: enforced in Nakama', !!(ban && (await bansUntil(b.userId, (x) => x.queue && x.queue.banId === ban.id))))
	if (ban) {
		const ub = acted('anti_cheat: moderator unban (resolved item)', await act(P.acB, 'unban', mod, { banId: ban.id }), 'unban')
		check('unban: lifted in Postgres and Nakama', ub && ub.effects.liftedBan.liftedAt && !!(await bansUntil(b.userId, (x) => !x.queue)))
		refused('unban twice', await act(P.acB, 'unban', mod, { banId: ban.id }), 404, 'ban_not_found')
	}
	const v = acted('anti_cheat: admin void (private game)', await act(P.acA, 'void', adm, { note: 'sq live void' }), 'void')
	check('void (private): no ratings to rebuild', v && v.effects.voided.runId === P.runId && v.effects.voided.rerated === false, JSON.stringify(v && v.effects))
	check('void: item resolved by void', itemRow(P.acA).status === 'resolved' && itemRow(P.acA).resolutionAction === 'void')
}

async function privateConflictChecks(P, mod, adm, a, b) {
	const d = await detail(P.conflict, mod)
	const ev = d.ok ? d.body.evidence : {}
	check('conflict evidence: lobbyKind private, no matchmade record', ev.lobbyKind === 'private' && ev.match === null, JSON.stringify({ k: ev.lobbyKind, m: ev.match }))
	check(
		'conflict evidence: both sides, first agrees with the recorded result',
		Array.isArray(ev.sides) && ev.sides.length === 2 && ev.sides[0].playerId === P.pa && ev.sides[0].agreesWithResult === true && ev.sides[1].agreesWithResult === false,
		JSON.stringify(ev.sides),
	)
	const byId = Object.fromEntries((ev.players || []).map((p) => [p.id, p]))
	check('conflict evidence: per-player flags and log checks', byId[P.pa]?.flag === 'elapsed_time_gate' && byId[P.pb]?.flag === 'hash_mismatch' && byId[P.pb]?.logCheck === 'mismatch', JSON.stringify(ev.players))
	check('conflict: subject card is null (no single subject)', d.ok && d.body.subject === null)
	refused('conflict: moderator overturn', await act(P.conflict, 'overturn', mod, { toReportOf: P.pb }), 403, 'forbidden')
	refused('conflict: overturn to the recorded side', await act(P.conflict, 'overturn', adm, { toReportOf: P.pa }), 409, 'unchanged')
	refused('conflict: overturn to an outsider', await act(P.conflict, 'overturn', adm, { toReportOf: '00000000-0000-0000-0000-000000000000' }), 400, 'invalid_target')
	refused('conflict: overturn body missing', await act(P.conflict, 'overturn', adm, {}), 400, 'invalid_body')
	const o = acted('conflict (private): admin overturn to b', await act(P.conflict, 'overturn', adm, { toReportOf: P.pb }), 'overturn')
	check('overturn (private): b now first, not rerated', o && o.effects.overturned.rerated === false && o.effects.overturned.placements[0].playerId === P.pb, JSON.stringify(o && o.effects))
	const run = await admin('admin_run_get', { runId: P.runId })
	check('overturn: Nakama run record has the new result', run.ok && run.body.run.placements.find((p) => p.place === 1)?.playerId === b.userId, run.text.slice(0, 200))
	check('overturn: source conflict resolved with the queue item', sourceStatus('match_result_conflicts', P.conflictId) === 'resolved' && itemRow(P.conflict).status === 'resolved')
	refused('conflict: overturn again', await act(P.conflict, 'overturn', adm, { toReportOf: P.pb }), 409, 'wrong_status')
	acted('conflict: moderator reopen', await act(P.conflict, 'reopen', mod), 'reopen')
	check('reopen: queue item and source conflict open again', itemRow(P.conflict).status === 'open' && sourceStatus('match_result_conflicts', P.conflictId) === 'open')
	acted('conflict: moderator resolve', await act(P.conflict, 'resolve', mod, { note: 'accept recorded result' }), 'resolve')
	check('resolve: source conflict resolved', sourceStatus('match_result_conflicts', P.conflictId) === 'resolved')
}

async function rankedConflictChecks(R, mod, adm) {
	const [ph, po] = [pgId(R.host.userId), pgId(R.other.userId)]
	// Nakama rates agreed and partial results only (rating/apply.ts).
	const before = ratingsOf([ph, po], R.gameMode)
	check('ranked dispute: not rated while disputed', !before[ph] && !before[po], JSON.stringify(before))
	const d = await detail(R.conflict, adm)
	const ev = d.ok ? d.body.evidence : {}
	check('ranked conflict evidence: lobbyKind ranked, matchmade record', ev.lobbyKind === 'ranked' && ev.match && ev.match.matchId === R.runId, JSON.stringify(ev.match))
	check('ranked conflict: admin may overturn and void', actionsOf(d).includes('overturn') && actionsOf(d).includes('void'))
	const o = acted('conflict (ranked): admin overturn to the other side', await act(R.conflict, 'overturn', adm, { toReportOf: po }), 'overturn')
	check('overturn (ranked): rerated', o && o.effects.overturned.rerated === true, JSON.stringify(o && o.effects))
	const after = ratingsOf([ph, po], R.gameMode)
	check(
		'overturn (ranked): ratings re-applied, the other side now won',
		after[po] && after[po].wins === 1 && after[po].losses === 0 && after[ph].wins === 0 && after[ph].losses === 1,
		JSON.stringify(after),
	)
	const mm = psql('bmp', `select result_placements::text from matchmaking_matches where match_id = ${q(R.runId)}`)
	const first = mm.length ? JSON.parse(mm[0][0]).find((p) => p.place === 1) : null
	check('overturn (ranked): matchmaking_matches result updated', first && first.playerId === po, mm.length ? mm[0][0] : '')
}

async function flaggedChatChecks(P, mod, adm, b) {
	const d = await detail(P.flagged, mod)
	const ev = d.ok ? d.body.evidence : {}
	check('flagged_chat evidence: the message and a remote verdict', ev.message && ev.message.message === P.abusive && ev.verdict && ev.verdict.source === 'remote', JSON.stringify(ev.verdict))
	check('flagged_chat evidence: source lobby', ev.source && ev.source.lobbyCode === P.lobby.code, JSON.stringify(ev.source))
	const ctx = ev.context || []
	check(
		'flagged_chat evidence: the line in its context, the clean lines before it',
		ctx.some((l) => l.isFlaggedLine && l.bySubject && l.message === P.abusive) && ctx.some((l) => l.message === 'gl hf' && !l.bySubject),
		JSON.stringify(ctx.map((l) => [l.message.slice(0, 12), l.bySubject, l.isFlaggedLine])),
	)
	check('flagged_chat: not muted yet', ev.alreadyMuted === false)
	check('flagged_chat: moderator presets 24h/7d/30d (permanent is admin)', JSON.stringify(presetsOf(d, 'chat_mute')) === '["24h","7d","30d"]', JSON.stringify(presetsOf(d, 'chat_mute')))
	refused('flagged_chat: queue_ban is not for this type', await act(P.flagged, 'queue_ban', mod, { duration: '7d' }), 400, 'not_for_type')
	refused('flagged_chat: moderator permanent mute', await act(P.flagged, 'chat_mute', mod, { duration: 'permanent' }), 403, 'forbidden')
	const m = acted('flagged_chat: moderator chat_mute 7d', await act(P.flagged, 'chat_mute', mod, { duration: '7d', reason: 'sq live abuse' }), 'chat_mute')
	const ban = m && m.effects.ban
	check('chat_mute: enforced in Nakama', !!(ban && (await bansUntil(b.userId, (x) => x.chat && x.chat.banId === ban.id))))
	const sent = await rpc(b.token, 'chat_send', { message: 'hello again' })
	check('chat_mute: the muted player is refused at chat_send', !sent.ok && /ban|mute/i.test(sent.text), sent.text.slice(0, 120))
	check('chat_mute: mute shows on the evidence', (await detail(P.flagged, mod)).body.evidence.alreadyMuted === true)
	if (ban) {
		acted('flagged_chat: admin unban', await act(P.flagged, 'unban', adm, { banId: ban.id }), 'unban')
		check('unban: chat ban gone in Nakama', !!(await bansUntil(b.userId, (x) => !x.chat)))
	}
}

async function rankedReportChecks(R, mod, adm) {
	const [ph, po] = [pgId(R.host.userId), pgId(R.other.userId)]
	const d = await detail(R.report, mod)
	const ev = d.ok ? d.body.evidence : {}
	check('report (ranked) evidence: report, reporter and reported cards', ev.report && ev.report.id === R.reportId && ev.reporter.id === ph && ev.reported.id === po, d.text.slice(0, 200))
	check('report (ranked) evidence: the game (Nakama run + replay)', ev.run && ev.run.run.runId === R.runId && ev.run.run.status === 'disputed' && ev.replay && ev.replay.runId === R.runId)
	check('report (ranked): subject card is the reported player', d.ok && d.body.subject.player.id === po && d.body.subject.reportsAgainst.total >= 1)
	check('report: moderator queue_ban presets are 7d only', JSON.stringify(presetsOf(d, 'queue_ban')) === '["7d"]')
	refused('report: moderator queue_ban 30d', await act(R.report, 'queue_ban', mod, { duration: '30d' }), 403, 'forbidden')
	// A false report: the ban goes to the reporter.
	const qb = acted('report: moderator queue_ban 7d on the reporter', await act(R.report, 'queue_ban', mod, { duration: '7d', targetPlayerId: ph, reason: 'false report' }), 'queue_ban')
	const ban = qb && qb.effects.ban
	check('queue_ban: the reporter banned in Nakama', !!(ban && ban.playerId === ph && (await bansUntil(R.host.userId, (x) => x.queue && x.queue.banId === ban.id))))
	check('report source follows the item: resolved', sourceStatus('reports', R.reportId) === 'resolved')
	if (ban) {
		acted('report: moderator unban the reporter', await act(R.report, 'unban', mod, { banId: ban.id }), 'unban')
		check('unban: reporter queue ban gone in Nakama', !!(await bansUntil(R.host.userId, (x) => !x.queue)))
	}
	refused('report: dismiss a resolved item', await act(R.report, 'dismiss', mod), 409, 'wrong_status')
	acted('report: moderator reopen', await act(R.report, 'reopen', mod), 'reopen')
	check('reopen: report source open again', sourceStatus('reports', R.reportId) === 'open')
	acted('report: admin dismiss', await act(R.report, 'dismiss', adm), 'dismiss')
	check('dismiss: report and item resolved by dismiss', sourceStatus('reports', R.reportId) === 'resolved' && itemRow(R.report).resolutionAction === 'dismiss')
	const legacy = await express('PATCH', `${W}/reports/${R.reportId}/resolve`, { token: mod.token, body: {} })
	refused('legacy reports/:id/resolve on a resolved item', legacy, 409, 'wrong_status')
}

async function forfeitChecks(F, mod, adm) {
	if (!F.itemId) return check('forfeit checks skipped (no item)', false)
	const ids = [pgId(F.host.userId), pgId(F.other.userId)]
	const rated = await poll(() => {
		const r = ratingsOf(ids, F.gameMode)
		return r[ids[0]] && r[ids[0]].games === 1 ? r : null
	}, 20000)
	check('forfeit: the partial ranked game was rated', !!rated, JSON.stringify(rated))
	const d = await detail(F.itemId, mod)
	const ev = d.ok ? d.body.evidence : {}
	check('forfeit evidence: lobbyKind ranked, result partial', ev.lobbyKind === 'ranked' && ev.result && ev.result.status === 'partial', JSON.stringify({ k: ev.lobbyKind, r: ev.result }))
	check(
		'forfeit evidence: timeline started, forfeited, reconnected',
		Array.isArray(ev.timeline) && ['started', 'forfeited', 'reconnected'].every((e) => ev.timeline.some((t) => t.event === e)),
		JSON.stringify(ev.timeline),
	)
	check('forfeit: subject is the returning player', d.ok && d.body.subject.player.id === ids[1])
	check('forfeit: no warn for this type', !actionsOf(d).includes('warn'))
	refused('forfeit: moderator void', await act(F.itemId, 'void', mod), 403, 'forbidden')
	const legacy = await express('PATCH', `${W}/forfeit-reconciliation/${F.flagId}/void`, { token: mod.token, body: {} })
	check('forfeit: legacy void route is admin-only too (403)', legacy.status === 403, `${legacy.status} ${legacy.text.slice(0, 120)}`)
	const v = acted('forfeit: admin void', await act(F.itemId, 'void', adm, { note: 'wrongful forfeit' }), 'void')
	check('void (ranked): rerated', v && v.effects.voided.rerated === true, JSON.stringify(v && v.effects))
	check('void: matchmaking_matches voided, flag voided', psql('bmp', `select status from matchmaking_matches where match_id = ${q(F.runId)}`)[0][0] === 'voided' && sourceStatus('forfeit_reconciliation_flags', F.flagId) === 'voided')
	const after = ratingsOf(ids, F.gameMode)
	check('void: ratings rebuilt without the game', ids.every((id) => !after[id] || after[id].games === 0), JSON.stringify(after))
	acted('forfeit: moderator reopen', await act(F.itemId, 'reopen', mod), 'reopen')
	check('reopen: flag open again', sourceStatus('forfeit_reconciliation_flags', F.flagId) === 'open')
	acted('forfeit: moderator resolve', await act(F.itemId, 'resolve', mod), 'resolve')
	check('resolve: flag dismissed', sourceStatus('forfeit_reconciliation_flags', F.flagId) === 'dismissed')
}

async function privateReportAndClaimChecks(P, mod, adm, a, b, outsider) {
	const id = P.report
	const d = await detail(id, mod)
	const ev = d.ok ? d.body.evidence : {}
	check('report (private) evidence: reporter a, reported b', ev.report && ev.report.id === P.reportId && ev.reporter.id === P.pa && ev.reported.id === P.pb, d.text.slice(0, 200))
	check(
		"report (private) evidence: lobby chat with the subject's lines marked",
		Array.isArray(ev.chat) && ev.chat.some((l) => l.message === 'you too' && l.bySubject) && ev.chat.some((l) => l.message === 'gl hf' && !l.bySubject),
		JSON.stringify((ev.chat || []).map((l) => [l.message, l.bySubject])),
	)
	check('report (private) evidence: the lobby game', ev.run && ev.run.run.runId === P.runId)
	const subj = d.ok ? d.body.subject : {}
	check(
		"subject card: b's other items (anti_cheat, flagged_chat) listed",
		subj.otherItems &&
			['anti_cheat', 'flagged_chat'].every((t) => [...subj.otherItems.open, ...subj.otherItems.recentResolved].some((i) => i.itemType === t)) &&
			subj.reportsAgainst.total >= 1,
		JSON.stringify(subj.otherItems && [...subj.otherItems.open, ...subj.otherItems.recentResolved].map((i) => i.itemType)),
	)
	check('detail: role moderator, no account_ban', d.ok && d.body.role === 'moderator' && !actionsOf(d).includes('account_ban'))
	const da = await detail(id, adm)
	check('detail as admin: account_ban, permanent mute', da.ok && da.body.role === 'admin' && actionsOf(da).includes('account_ban') && presetsOf(da, 'chat_mute').includes('permanent'))

	// Claims.
	const c1 = await claim(id, mod)
	check('claim: moderator claims for 15 minutes', c1.ok && c1.body.claim.claimedBy === `moderator:${mod.id}` && Math.abs(new Date(c1.body.claim.claimedUntil) - Date.now() - 15 * 60000) < 60000, c1.text.slice(0, 200))
	refused('claim: admin blocked by the claim', await claim(id, adm), 409, 'claimed')
	refused('claim: admin action blocked by the claim', await act(id, 'dismiss', adm), 409, 'claimed')
	acted('claim: a note is exempt from the claim', await act(id, 'note', adm, { note: 'admin looked' }), 'note')
	refused('claim: note needs text', await act(id, 'note', mod, {}), 400, 'invalid_body')
	const mine = await express('GET', `${SQ}?claimedByMe=1&limit=100`, { token: mod.token })
	check('list: claimedByMe shows the claimed item', mine.ok && mine.body.items.some((i) => i.id === id && i.claim && i.claim.claimedBy === `moderator:${mod.id}`))
	refused('release: admin without force', await release(id, adm), 409, 'claimed')
	refused('release: moderator cannot force', await release(id, mod, true), 403, 'forbidden')
	const fr = await release(id, adm, true)
	check('release: admin force-release', fr.ok && fr.body.claim === null && itemRow(id).claimedBy === null, fr.text.slice(0, 160))
	check('claim: moderator claims again', (await claim(id, mod)).ok)

	// Warn: 109 to the subject's socket.
	const mark = b.socket.mark()
	refused('warn: needs a message', await act(id, 'warn', mod, {}), 400, 'invalid_body')
	refused('warn: an outsider is no target', await act(id, 'warn', mod, { message: 'x', targetPlayerId: outsider }), 400, 'invalid_target')
	const w = acted('warn: moderator warns the subject', await act(id, 'warn', mod, { message: 'Keep chat civil.' }), 'warn')
	check('warn: warning row, delivered', w && w.effects.warningId && w.effects.delivered === true, JSON.stringify(w && w.effects))
	const note = await b.socket.waitFor((x) => x.kind === 'notification' && x.code === NOTIFY_WARNED, 8000, mark)
	check(
		'warn: WARNED (109) arrives with the message and item type',
		note && note.content.message === 'Keep chat civil.' && note.content.itemType === 'report' && typeof note.content.warnedAt === 'number',
		JSON.stringify(note),
	)
	check('warn: claim cleared on close, report resolved', itemRow(id).claimedBy === null && sourceStatus('reports', P.reportId) === 'resolved')
	check('warn: response lists the resolved-item actions', w && JSON.stringify(w.allowedActions.map((x) => x.action)) === '["reopen","unban","note"]', JSON.stringify(w && w.allowedActions))
	const card = await detail(id, mod)
	check('warn: on the subject card', card.ok && card.body.subject.warnings.some((x) => x.message === 'Keep chat civil.'))

	// Account ban: admin only, on the reporter (false report).
	acted('report: reopen', await act(id, 'reopen', mod), 'reopen')
	refused('report: moderator account_ban', await act(id, 'account_ban', mod, { duration: '7d' }), 403, 'forbidden')
	const ab = acted('report: admin account_ban 7d on the reporter', await act(id, 'account_ban', adm, { duration: '7d', targetPlayerId: P.pa, reason: 'false report' }), 'account_ban')
	const ban = ab && ab.effects.ban
	check('account_ban: enforced in Nakama', !!(ban && (await bansUntil(a.userId, (x) => x.account && x.account.banId === ban.id))))
	if (ban) {
		refused('unban: moderator may not lift an account ban', await act(id, 'unban', mod, { banId: ban.id }), 403, 'forbidden')
		refused('unban: a ban id that is no target of this item', await act(P.flagged, 'unban', adm, { banId: ban.id }), 404, 'ban_not_found')
		acted('unban: admin lifts the account ban', await act(id, 'unban', adm, { banId: ban.id }), 'unban')
		check('unban: account ban gone in Nakama', !!(await bansUntil(a.userId, (x) => !x.account)))
	}

	// The audit trail.
	const evs = await express('GET', `${SQ}/${id}/events`, { token: mod.token })
	const kinds = evs.ok ? evs.body.events.map((e) => e.kind) : []
	check(
		'events: viewed, claimed, released, noted, acted, reopened all recorded',
		['viewed', 'claimed', 'released', 'noted', 'acted', 'reopened'].every((k) => kinds.includes(k)),
		JSON.stringify(kinds),
	)
	check('events: actors are role:playerId', evs.ok && evs.body.events.some((e) => e.actor === `admin:${adm.id}`) && evs.body.events.some((e) => e.actor === `moderator:${mod.id}`))
}

async function listChecks(mod, P) {
	const all = await express('GET', `${SQ}?limit=100`, { token: mod.token })
	check('list: total, pages, counts for every type', all.ok && typeof all.body.total === 'number' && ['report', 'flagged_chat', 'match_conflict', 'forfeit_reconciliation', 'anti_cheat', 'integrity'].every((t) => typeof all.body.counts[t] === 'number'), all.text.slice(0, 200))
	const pri = all.ok ? all.body.items.filter((i) => i.status === 'open').map((i) => i.priority) : []
	check('list: open items by priority, highest first', pri.every((p, i) => i === 0 || pri[i - 1] >= p), JSON.stringify(pri.slice(0, 12)))
	const bySubject = await express('GET', `${SQ}?subject=${encodeURIComponent(PREFIX + 'sq_' + stamp + '_b')}&limit=100`, { token: mod.token })
	check('list: subject filter finds b\'s items', bySubject.ok && bySubject.body.items.length >= 3 && bySubject.body.items.every((i) => i.subjectPlayerId === P.pb), bySubject.ok ? `${bySubject.body.items.length}` : bySubject.text)
	const ac = await express('GET', `${SQ}?itemType=anti_cheat&status=resolved&limit=100`, { token: mod.token })
	check('list: type + status filters', ac.ok && ac.body.items.every((i) => i.itemType === 'anti_cheat' && i.status === 'resolved') && ac.body.items.some((i) => i.id === P.acA))
	refused('detail: unknown id', await detail(999999999, mod), 404, 'not_found')
	refused('action: unknown action', await act(P.acA, 'smite', mod), 400, 'unknown_action')
	const plain = await express('GET', SQ, { token: webJwt(P.pa, 'plain') })
	check('list: a non-staff player gets 403', plain.status === 403, `${plain.status}`)
}

// ---------------------------------------------------------------------------
// Integrity (needs DEV_FAKE_LAUNCHER_STRATEGY=true on api-green)
// ---------------------------------------------------------------------------

// Starts a launcher session and refuses its login challenge; false when no
// challenge came (no strategy registered).
export async function refuseChallenge(p) {
	const mark = p.socket.mark()
	const started = await rpc(p.token, 'launcher_session_start', {})
	if (!started.ok || !started.body.started) return false
	const ch = await p.socket.waitFor((x) => x.kind === 'notification' && x.code === NOTIFY_CHALLENGE && x.content && x.content.type === 'issued', 6000, mark)
	if (!ch) return false
	const r = await rpc(p.token, 'launcher_challenge_answer', { challengeId: ch.content.challengeId, refused: true })
	return r.ok
}

async function integrityRun(mod, adm) {
	const [i1, i2] = [await player('i1'), await player('i2')]
	// A mirrored game first: the audit trail needs a players row.
	await lobbyWith([i1, i2], { modId: MOD })
	await startGame([i1, i2], {})
	for (const p of [i1, i2]) await p.socket.ask('mpapi_report_result', { placements: placementsOf([i1, i2]) })
	const rows = await poll(() => pgId(i1.userId) && pgId(i2.userId), 40000)
	check('integrity: players rows made by the mirror', !!rows)
	for (const p of [i1, i2]) p.socket.sendOp(1, {})
	await sleep(800)
	const [p1, p2] = [pgId(i1.userId), pgId(i2.userId)]
	const day = new Date().toISOString().slice(0, 10)

	// Outside ranked: the third failure of the day raises it.
	const first = await refuseChallenge(i1)
	check('integrity: a challenge came and was refused (needs DEV_FAKE_LAUNCHER_STRATEGY=true)', first)
	if (!first) return
	await sleep(1500)
	check('integrity: no item after 1 failure outside ranked', !(await itemFor('integrity', `${p1}:${day}`, 1500)))
	await refuseChallenge(i1)
	await sleep(1500)
	check('integrity: no item after 2 failures', !(await itemFor('integrity', `${p1}:${day}`, 1500)))
	await refuseChallenge(i1)
	const repeated = await itemFor('integrity', `${p1}:${day}`, 15000)
	check('integrity: the 3rd failure raises an item (trigger repeated)', !!repeated && itemRow(repeated).context.integrityTrigger === 'repeated', JSON.stringify(repeated && itemRow(repeated)))

	// In the ranked queue: the first failure raises it.
	const t = await i2.socket.request({
		matchmaker_add: { min_count: 2, max_count: 2, query: `+properties.modId:${MOD} +properties.mode:${PREFIX}sqi_${stamp} +properties.kind:ranked`, string_properties: { modId: MOD, mode: `${PREFIX}sqi_${stamp}`, kind: 'ranked' } },
	})
	check('integrity: i2 queued for ranked', !!t.matchmaker_ticket, JSON.stringify(t).slice(0, 160))
	// The queue record is written by the MatchmakerAdd after-hook, which Nakama
	// runs after the ticket reply: give it a moment.
	let ctx
	for (let tries = 0; tries < 20; tries++) {
		ctx = await admin('admin_player_get', { userId: i2.userId })
		if (ctx.ok && ctx.body.ranked && ctx.body.ranked.queued === true) break
		await sleep(150)
	}
	check('admin_player_get: ranked.queued', ctx.ok && ctx.body.ranked && ctx.body.ranked.queued === true, ctx.text.slice(0, 200))
	await refuseChallenge(i2)
	const ranked = await itemFor('integrity', `${p2}:${day}`, 15000)
	check('integrity: one failure while queued for ranked raises an item (trigger ranked)', !!ranked && itemRow(ranked).context.integrityTrigger === 'ranked' && itemRow(ranked).context.lobbyKind === 'ranked')
	if (t.matchmaker_ticket) await i2.socket.request({ matchmaker_remove: { ticket: t.matchmaker_ticket.ticket } }).catch(() => {})

	if (repeated) {
		const d = await detail(repeated, mod)
		const ev = d.ok ? d.body.evidence : {}
		check('integrity evidence: the day, trigger and its 3 failures', ev.day === day && ev.trigger === 'repeated' && ev.today.length === 3 && ev.today.every((e) => e.reason === 'refused'), JSON.stringify({ day: ev.day, t: ev.trigger, n: ev.today && ev.today.length }))
		check('integrity: subject card has the Nakama view', d.ok && d.body.subject.nakama && d.body.subject.nakama.integrity !== undefined)
		refused('integrity: void is not for this type', await act(repeated, 'void', adm), 400, 'not_for_type')
		const mark = i1.socket.mark()
		acted('integrity: moderator warn', await act(repeated, 'warn', mod, { message: 'Use the launcher for ranked.' }), 'warn')
		const n = await i1.socket.waitFor((x) => x.kind === 'notification' && x.code === NOTIFY_WARNED, 8000, mark)
		check('integrity warn: 109 delivered with itemType integrity', n && n.content.itemType === 'integrity', JSON.stringify(n))
	}
	if (ranked) {
		const qb = acted('integrity: moderator queue_ban 7d', await act(ranked, 'queue_ban', mod, { duration: '7d', reason: 'integrity' }), 'queue_ban')
		const ban = qb && qb.effects.ban
		check('integrity queue_ban: in Nakama', !!(ban && (await bansUntil(i2.userId, (x) => x.queue && x.queue.banId === ban.id))))
		if (ban) {
			acted('integrity: admin unban', await act(ranked, 'unban', adm, { banId: ban.id }), 'unban')
			check('integrity unban: gone in Nakama', !!(await bansUntil(i2.userId, (x) => !x.queue)))
		}
	}
	for (const p of [i1, i2]) p.socket.close()
}

// ---------------------------------------------------------------------------

async function main() {
	const integrityOnly = process.argv[2] === 'integrity'
	const snapshot = configSnapshot()
	// api-green's boot pushes integrityEnforced on with the fake strategy; the
	// baseline is off.
	if (integrityOnly) snapshot.integrityEnforced = false
	console.log('config as found: ' + JSON.stringify(snapshot))
	const mod = staffRow(PREFIX + 'sq_mod', ['moderator'])
	const adm = staffRow(PREFIX + 'sq_admin', ['admin'])
	try {
		if (integrityOnly) {
			await admin('admin_config_set', { integrityEnforced: false })
			await integrityRun(mod, adm)
			return
		}
		const chatOn = await admin('admin_config_set', { chatEnabled: true })
		check('chat turned on for the run', chatOn.ok && chatOn.body.chatEnabled === true, chatOn.text.slice(0, 120))

		const forfeit = forfeitGame() // ~2.5 minutes, alongside the rest
		const [a, b, c, d, o] = [await player('a'), await player('b'), await player('c'), await player('d'), await player('o')]
		for (const p of [a, b]) {
			const en = await rpc(p.token, 'chat_enable', {})
			if (!en.ok) throw new Error('chat_enable: ' + en.text)
		}
		const P = await privateLobby(a, b)
		const R = await rankedDispute(c, d)
		const outsider = pgId(c.userId)

		await antiCheatChecks(P, mod, adm, b)
		await privateConflictChecks(P, mod, adm, a, b)
		await rankedConflictChecks(R, mod, adm)
		await flaggedChatChecks(P, mod, adm, b)
		await rankedReportChecks(R, mod, adm)
		await privateReportAndClaimChecks(P, mod, adm, a, b, outsider)
		await listChecks(mod, P)
		await forfeitChecks(await forfeit, mod, adm)
		for (const p of [a, b, c, d, o]) p.socket.close()
	} finally {
		await restoreConfig(snapshot)
	}
	await sleep(300)
}

// Only when run directly: service-queue-seed.live.mjs imports the scenarios.
if (import.meta.url === pathToFileURL(process.argv[1]).href)
	main()
		.catch((e) => {
			console.error(e)
			process.exitCode = 2
		})
		.finally(() => {
			if (process.exitCode !== 2) process.exitCode = summary('service-queue.live') ? 1 : 0
			setTimeout(() => process.exit(process.exitCode), 500)
		})
