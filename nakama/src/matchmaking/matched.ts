// Turns a matchmaker group into a seated lobby. Pure planning is split from
// the Nakama calls so the rules (a group must agree on what it queued for)
// can be tested.
import { generateCode, CODE_ATTEMPTS, MATCHMADE_CODE_LENGTH } from '../lobby/rpc'
import { bindCode, releaseCode, reserveCode } from '../lobby/codes'
import { LOBBY_MATCH } from '../lobby/protocol'
import { clearMatched } from './queue'

export interface MatchedEntry {
	presence: { userId: string }
	properties: { [key: string]: string }
}

export interface MatchPlan {
	modId: string
	// The rating board the game counts on, '' for a casual game.
	rankedMode: string
	// The queue, keyed as the API keys it: 'mode', or 'ranked:mode'.
	gameMode: string
	playerIds: string[]
}

// How the API names a queue: the bare mode, 'ranked:'-prefixed when ranked.
export function queueKey(mode: string, kind: string): string {
	return kind === 'ranked' ? 'ranked:' + mode : mode
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

// What a matched group queued for, or why it can't be a lobby. Everyone must
// have asked for the same mod, mode and kind: the query already ensures it,
// this stops a hand-built ticket from dragging others into a different game.
export function planMatch(entries: MatchedEntry[]): MatchPlan | string {
	if (entries.length < 2) return 'A match needs at least two players'
	const first = entries[0].properties
	const modId = first.modId
	const mode = first.mode
	const kind = first.kind === 'ranked' ? 'ranked' : 'casual'
	if (!NAME_PATTERN.test(modId || '') || !NAME_PATTERN.test(mode || ''))
		return 'Ticket has no valid modId and mode'
	const ids: string[] = []
	for (const entry of entries) {
		const p = entry.properties
		if (
			p.modId !== modId ||
			p.mode !== mode ||
			(p.kind === 'ranked' ? 'ranked' : 'casual') !== kind
		)
			return 'Tickets disagree on what they queued for'
		if (ids.indexOf(entry.presence.userId) !== -1)
			return 'A player is in the match twice'
		ids.push(entry.presence.userId)
	}
	return {
		modId,
		rankedMode: kind === 'ranked' ? mode : '',
		gameMode: queueKey(mode, kind),
		playerIds: ids,
	}
}

export function matchmakerMatched(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	matches: MatchedEntry[],
): string {
	const plan = planMatch(matches)
	if (typeof plan === 'string') {
		logger.warn('Matchmaker group refused: %s', plan)
		throw new Error(plan)
	}
	for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
		const code = generateCode(MATCHMADE_CODE_LENGTH)
		if (!reserveCode(nk, code, plan.modId)) continue
		let matchId: string
		try {
			matchId = nk.matchCreate(LOBBY_MATCH, {
				code,
				modId: plan.modId,
				maxPlayers: plan.playerIds.length,
				creatorId: plan.playerIds[0],
				rankedMode: plan.rankedMode,
				allowedIds: plan.playerIds.join(','),
				gameMode: plan.gameMode,
			})
		} catch (e) {
			releaseCode(nk, code, '')
			throw e
		}
		bindCode(nk, code, matchId, plan.modId)
		clearMatched(nk, plan.modId, plan.gameMode, plan.playerIds)
		logger.info(
			'Matchmaker made lobby %s for %d players (%s%s)',
			code,
			plan.playerIds.length,
			plan.modId,
			plan.rankedMode ? ', ranked ' + plan.rankedMode : '',
		)
		return matchId
	}
	throw new Error('Could not allocate a lobby code')
}
