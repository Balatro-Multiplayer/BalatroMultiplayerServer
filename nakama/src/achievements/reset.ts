// The one-off avatar reset before achievements are switched on: every
// player's joker goes back to the default unless they may still pick it with
// nothing earned (a default or a privilege joker), and all achievement
// progress is deleted. Paged, so the API calls it until the cursor is ''.
// dryRun counts without changing anything.
import { INVALID_ARGUMENT, runtimeError } from '../errors'
import { profileChanged } from '../player/rpc'
import { PLAYER_COLLECTION, PROFILE_KEY, profileOf, updateProfile } from '../player/profile'
import { parsePayload, requireServer } from '../rpc'
import { DEFAULT_AVATAR } from '../shared/avatars/ids'
import { isSelectable } from '../shared/avatars/unlocked'
import { deleteProgress, PROGRESS_COLLECTION } from './storage'

const PAGE = 100

// Profiles first, then progress records: 'profiles:<cursor>' / 'progress:<cursor>'.
type Phase = 'profiles' | 'progress'

interface Position {
	phase: Phase
	cursor: string
}

export function parseCursor(value: unknown): Position {
	if (value === undefined || value === '') return { phase: 'profiles', cursor: '' }
	if (typeof value === 'string') {
		const at = value.indexOf(':')
		const phase = value.slice(0, at)
		if (at > 0 && (phase === 'profiles' || phase === 'progress')) return { phase, cursor: value.slice(at + 1) }
	}
	throw runtimeError(INVALID_ARGUMENT, 'Invalid cursor')
}

function cursorOf(position: Position | null): string {
	return position ? `${position.phase}:${position.cursor}` : ''
}

// Whether the joker survives the reset: one the player may pick with nothing earned.
export function keepsJoker(joker: string, privileges: readonly string[]): boolean {
	return isSelectable(joker, { privileges, unlocked: [] })
}

function listPage(nk: nkruntime.Nakama, collection: string, cursor: string) {
	try {
		return nk.storageList(null, collection, PAGE, cursor)
	} catch (e) {
		// Nakama throws "Malformed cursor was used" for a cursor it didn't issue.
		if (cursor !== '') throw runtimeError(INVALID_ARGUMENT, 'Invalid cursor')
		throw e
	}
}

// {cursor?, dryRun?} -> {dryRun, checked, jokersReset, progressDeleted, cursor}
export function rpcAdminAvatarsReset(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string) {
	requireServer(ctx)
	const input = parsePayload(payload)
	const position = parseCursor(input.cursor)
	if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw runtimeError(INVALID_ARGUMENT, 'dryRun must be a boolean')
	const dryRun = input.dryRun === true
	let checked = 0
	let jokersReset = 0
	let progressDeleted = 0
	let next: Position | null

	if (position.phase === 'profiles') {
		const page = listPage(nk, PLAYER_COLLECTION, position.cursor)
		for (const object of page.objects || []) {
			if (object.key !== PROFILE_KEY) continue
			checked++
			const stored = profileOf(object.value, '')
			if (keepsJoker(stored.preferredJoker, stored.privileges)) continue
			jokersReset++
			if (dryRun) continue
			const profile = updateProfile(nk, object.userId, (current) =>
				keepsJoker(current.preferredJoker, current.privileges) ? current : { ...current, preferredJoker: DEFAULT_AVATAR },
			)
			profileChanged(nk, object.userId, profile)
		}
		next = page.cursor ? { phase: 'profiles', cursor: page.cursor } : { phase: 'progress', cursor: '' }
	} else {
		const page = listPage(nk, PROGRESS_COLLECTION, position.cursor)
		for (const object of page.objects || []) {
			progressDeleted++
			if (!dryRun) deleteProgress(nk, object.userId)
		}
		// Deleting shifts what a cursor points at; a real run starts the
		// progress listing over until nothing is left.
		next = page.cursor ? { phase: 'progress', cursor: dryRun ? page.cursor : '' } : null
	}
	logger.info('Avatar reset%s: %d checked, %d jokers reset, %d progress deleted', dryRun ? ' (dry run)' : '', checked, jokersReset, progressDeleted)
	return JSON.stringify({ dryRun, checked, jokersReset, progressDeleted, cursor: cursorOf(next) })
}
