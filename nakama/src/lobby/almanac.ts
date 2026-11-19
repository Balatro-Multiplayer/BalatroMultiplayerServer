// Almanac's in-run deck draft. One shared offer and two independent picks at
// each milestone. The ledger survives disconnects, host migration and restarts;
// clients never supply offers or their acquisition history.
import { PVP_MOD_ID } from '../standing/pvp_version'
import {
	nextRng,
	paramsObject,
	rejectStep,
	seededRng,
} from './draft_support'
import { ServerOp } from './protocol'
import type { Lobby, Outbound, Step } from './state'

export const ALMANAC_RULESET = 'ruleset_mp_almanac'
export const ALMANAC_RANKED_MODE = 'pvp_ranked_almanac'
export const DECK_ANTES: { [key: string]: number } = {
	b_red: 2,
	b_blue: 2,
	b_yellow: 2,
	b_green: 2,
	b_black: 3,
	b_magic: 2,
	b_nebula: 2,
	b_ghost: 3,
	b_abandoned: 3,
	b_checkered: 3,
	b_zodiac: 2,
	b_painted: 3,
	b_anaglyph: 2,
	b_erratic: 2,
	b_mp_violet: 2,
	b_mp_indigo: 5,
	b_mp_orange: 2,
	b_mp_oracle: 5,
	b_mp_gradient: 5,
	b_mp_heidelberg: 7,
	b_mp_echodeck: 7,
}
const MILESTONES = [2, 3, 5, 7]
// A player who never answers a deck offer must not stall the other player at
// the next PvP blind: once this long has passed, the server rolls their pick.
export const DECK_PICK_MS = 60_000

export interface DeckOffer {
	id: string
	ante: number
	choices: string[]
	picks: { [player: string]: string }
	// Absent in an offer made before deadlines existed: it never times out.
	deadline?: number
}
export interface Almanac {
	run: string
	players: string[]
	acquired: { [player: string]: string[] }
	offers: { [ante: string]: DeckOffer }
}

export function isAlmanac(lobby: Lobby): boolean {
	return (
		lobby.modId === PVP_MOD_ID &&
		(lobby.rankedMode === ALMANAC_RANKED_MODE ||
			(!lobby.rankedMode &&
				!lobby.gameMode &&
				(lobby.metadata.ruleset === ALMANAC_RULESET ||
					lobby.metadata.deck === 'Almanac')))
	)
}

function offerMessage(
	lobby: Lobby,
	offer: DeckOffer,
	player: string,
	now: number,
): Outbound {
	return {
		kind: 'send',
		op: ServerOp.ACTION,
		to: [player],
		payload: {
			cid: '',
			action: 'pvp_almanac_offer',
			from: lobby.hostId,
			to: '*',
			params: {
				id: offer.id,
				ante: offer.ante,
				choices: offer.choices,
				picked: offer.picks[player],
				ms_left:
					offer.deadline === undefined
						? undefined
						: Math.max(0, offer.deadline - now),
			},
		},
	}
}

export function almanacAction(
	lobby: Lobby,
	from: string,
	key: string,
	input: unknown,
	now: number,
): Step | null {
	if (
		!['pvp_almanac_open', 'pvp_almanac_pick', 'pvp_almanac_offer'].includes(key)
	)
		return null
	const refuse = (reason: string): Step => rejectStep(lobby, from, key, reason)
	if (key === 'pvp_almanac_offer') return refuse('server_only')
	const started = lobby.game.started
	if (
		!isAlmanac(lobby) ||
		!started ||
		started.players.length !== 2 ||
		!started.players.some((p) => p.id === from)
	)
		return refuse('unavailable')
	if (lobby.players.length > 2) return refuse('too_many_players')
	if (lobby.players.length !== 2) return refuse('unavailable')
	const params = paramsObject(input)
	const ante = params.ante
	if (typeof ante !== 'number' || !MILESTONES.includes(ante))
		return refuse('bad_ante')
	const players = started.players.map((p) => p.id).sort()
	const current: Almanac =
		lobby.almanac?.run === started.runId
			? lobby.almanac
			: {
					run: started.runId,
					players,
					acquired: { [players[0]]: [], [players[1]]: [] },
					offers: {},
				}
	const existing = current.offers[ante]
	if (key === 'pvp_almanac_open') {
		if (existing) return { lobby, out: [offerMessage(lobby, existing, from, now)] }
		const previous = MILESTONES[MILESTONES.indexOf(ante) - 1]
		if (previous && !players.every((p) => !!current.offers[previous]?.picks[p]))
			return refuse('previous_pending')
		const pool = Object.keys(DECK_ANTES)
			.filter(
				(deck) =>
					DECK_ANTES[deck] <= ante &&
					players.every((p) => !current.acquired[p].includes(deck)),
			)
			.sort()
		const id = `${started.runId}:decks:${ante}`
		let rng = seededRng(id)
		const choices: string[] = []
		while (choices.length < 3 && pool.length > 0) {
			rng = nextRng(rng)
			choices.push(pool.splice(rng % pool.length, 1)[0])
		}
		const offer: DeckOffer = {
			id,
			ante,
			choices,
			picks: {},
			deadline: now + DECK_PICK_MS,
		}
		const next = {
			...lobby,
			almanac: { ...current, offers: { ...current.offers, [ante]: offer } },
		}
		return { lobby: next, out: [offerMessage(next, offer, from, now)] }
	}
	if (!existing || params.id !== existing.id) return refuse('stale_offer')
	// The deadline beats a pick that arrives after it.
	if (existing.deadline !== undefined && now >= existing.deadline)
		return almanacTick(lobby, now)
	// A retransmitted selection returns the original commitment, never changes it.
	if (existing.picks[from]) return { lobby, out: [offerMessage(lobby, existing, from, now)] }
	if (
		typeof params.deck !== 'string' ||
		!existing.choices.includes(params.deck)
	)
		return refuse('not_offered')
	const offer = {
		...existing,
		picks: { ...existing.picks, [from]: params.deck },
	}
	const state: Almanac = {
		...current,
		offers: { ...current.offers, [ante]: offer },
		acquired: {
			...current.acquired,
			[from]: [...current.acquired[from], params.deck],
		},
	}
	const next = { ...lobby, almanac: state }
	return { lobby: next, out: [offerMessage(next, offer, from, now)] }
}

// Rolls the pick of every player who let an offer's deadline pass, then tells
// both players the offer's outcome. Run on the match tick.
export function almanacTick(lobby: Lobby, now: number): Step {
	const current = lobby.almanac
	const started = lobby.game.started
	if (
		!current ||
		lobby.closed ||
		!started ||
		current.run !== started.runId ||
		current.players.some((id) => !lobby.players.some((p) => p.id === id))
	)
		return { lobby, out: [] }
	const offers = { ...current.offers }
	const acquired = { ...current.acquired }
	const expired: DeckOffer[] = []
	for (const key of Object.keys(offers)) {
		const offer = offers[key]
		if (
			offer.deadline === undefined ||
			now < offer.deadline ||
			current.players.every((id) => !!offer.picks[id])
		)
			continue
		const picks = { ...offer.picks }
		for (const id of current.players) {
			if (picks[id] || offer.choices.length === 0) continue
			const rolled =
				offer.choices[nextRng(seededRng(`${offer.id}:${id}`)) % offer.choices.length]
			picks[id] = rolled
			acquired[id] = [...acquired[id], rolled]
		}
		offers[key] = { ...offer, picks }
		expired.push(offers[key])
	}
	if (expired.length === 0) return { lobby, out: [] }
	const next = { ...lobby, almanac: { ...current, offers, acquired } }
	return {
		lobby: next,
		out: expired.flatMap((offer) =>
			current.players.map((id) => offerMessage(next, offer, id, now)),
		),
	}
}
