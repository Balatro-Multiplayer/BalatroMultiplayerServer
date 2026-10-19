// Counts of a player's own actions in their log: hands played, rerolls,
// skipped blinds, suit-changing consumables used, and PvP lives lost. Pure.
import type { LogEvent } from '../../shared/replay/events'
import { keyOfRef, learnRefs, type CardKeys } from './cards'

// Tarots and the Spectral that convert cards to one suit.
const SUIT_CHANGERS: { [key: string]: boolean } = { c_star: true, c_moon: true, c_sun: true, c_world: true, c_sigil: true }

// use / pack_pick args: [idx, targets, ref, target_refs].
const USED_REF_INDEX = 2

export function countOf(events: LogEvent[], opcode: string): number {
	let count = 0
	for (const event of events) if (event.opcode === opcode) count++
	return count
}

export function suitChangersUsed(events: LogEvent[]): number {
	const keys: CardKeys = {}
	let used = 0
	for (const event of events) {
		learnRefs(keys, event.args)
		if (event.opcode !== 'use' && event.opcode !== 'pack_pick') continue
		const ref = Array.isArray(event.args) ? event.args[USED_REF_INDEX] : null
		const key = keyOfRef(keys, ref)
		if (key !== null && SUIT_CHANGERS[key]) used++
	}
	return used
}

// life_lost {lost, lives}: lost defaults to one life.
export function livesLost(events: LogEvent[]): number {
	let lost = 0
	for (const event of events) {
		if (event.opcode !== 'life_lost') continue
		const args = event.args
		const value =
			args !== null && typeof args === 'object' && !Array.isArray(args)
				? (args as { lost?: unknown }).lost
				: Array.isArray(args)
					? args[0]
					: undefined
		lost += typeof value === 'number' && isFinite(value) && value > 0 ? Math.floor(value) : 1
	}
	return lost
}
