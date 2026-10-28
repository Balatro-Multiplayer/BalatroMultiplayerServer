// Avatar RPCs. avatar_catalog is the player's own view (the client's picker
// and Achievements tab); admin_avatars_for is the same view of any player
// for the BMP API (the website's /auth/jokers); admin_progress_set edits a
// player's progress, for testing only.
import { readConfig } from '../config'
import { INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED, runtimeError } from '../errors'
import { profileFor, readProfile } from '../player/profile'
import { parsePayload, requireServer, requireUser } from '../rpc'
import { CATALOG } from '../shared/avatars/catalog'
import { isAvatarId, type AvatarId } from '../shared/avatars/ids'
import { COUNTERS, MILESTONES, VANILLA_DECKS, type Milestone, type SpdrnMode } from '../shared/avatars/rules'
import { isSelectable, type Holdings } from '../shared/avatars/unlocked'
import { spdrnModeOf } from './facts/setup'
import { emptyProgress, type Progress, type StoredCounter } from './progress'
import { progressFor, updateProgress } from './storage'
import { goalOf, type Goal } from './unlocks'
import { settingsOf } from '../server_kind'

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRIVILEGE = /^[a-z0-9_-]{1,64}$/i

export interface CatalogView {
	avatars: { id: AvatarId; unlocked: boolean; goal: Goal | null }[]
	selected: string
	// Whether games currently count toward goals (achievementsEnabled).
	enabled: boolean
}

// Pure: every avatar, whether the player may pick it, and its goal.
export function catalogView(progress: Progress, holdings: Holdings, selected: string, enabled: boolean): CatalogView {
	return {
		avatars: CATALOG.map((entry) => ({
			id: entry.id,
			unlocked: isSelectable(entry.id, holdings),
			goal: goalOf(entry, progress, holdings),
		})),
		selected,
		enabled,
	}
}

function viewOf(nk: nkruntime.Nakama, userId: string, fallbackName: string): CatalogView {
	const profile = profileFor(nk, userId, fallbackName)
	const progress = progressFor(nk, userId)
	const holdings = { privileges: profile.privileges, unlocked: progress.unlocked }
	return catalogView(progress, holdings, profile.preferredJoker, readConfig(nk).achievementsEnabled)
}

// {} -> CatalogView
export function rpcAvatarCatalog(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string) {
	const userId = requireUser(ctx)
	return JSON.stringify(viewOf(nk, userId, ctx.username))
}

// {userId} | {privileges} -> CatalogView & {jokers}: jokers lists the ids the
// player may pick. {privileges} answers for a player with no Nakama account
// yet (nothing earned, the default joker selected).
export function rpcAdminAvatarsFor(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string) {
	requireServer(ctx)
	const input = parsePayload(payload)
	let view: CatalogView
	if (input.userId !== undefined) {
		if (typeof input.userId !== 'string' || !USER_ID.test(input.userId)) throw runtimeError(INVALID_ARGUMENT, 'Invalid userId')
		if (!readProfile(nk, input.userId)) throw runtimeError(NOT_FOUND, 'No such player')
		view = viewOf(nk, input.userId, '')
	} else {
		const privileges = input.privileges
		if (!Array.isArray(privileges) || !privileges.every((p) => typeof p === 'string' && PRIVILEGE.test(p)))
			throw runtimeError(INVALID_ARGUMENT, 'userId or privileges is required')
		const progress = emptyProgress()
		view = catalogView(progress, { privileges: privileges as string[], unlocked: [] }, 'j_joker', readConfig(nk).achievementsEnabled)
	}
	return JSON.stringify({ ...view, jokers: view.avatars.filter((a) => a.unlocked).map((a) => a.id) })
}

// Testing RPCs only exist on a Dev server (server_kind.ts).
export function testingRpcsAllowed(ctx: nkruntime.Context): boolean {
	return settingsOf(ctx).testingRpcs
}

type Fields = { [field: string]: unknown }
const isFields = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

// Pure: progress with the edit's fields replaced (counters and deckGames
// merge key by key). INVALID_ARGUMENT for anything malformed.
export function editedProgress(progress: Progress, edit: Fields): Progress {
	const next: Progress = { ...progress, counters: { ...progress.counters }, deckGames: { ...progress.deckGames } }
	if (edit.counters !== undefined) {
		if (!isFields(edit.counters)) throw runtimeError(INVALID_ARGUMENT, 'counters must be an object')
		for (const key in edit.counters) {
			const value = edit.counters[key]
			if (key === 'bestWinStreak') {
				if (!isCount(value)) throw runtimeError(INVALID_ARGUMENT, 'Invalid counter bestWinStreak')
				next.winStreak = { current: Math.min(next.winStreak.current, value), best: value }
				continue
			}
			if ((COUNTERS as readonly string[]).indexOf(key) === -1 || !isCount(value))
				throw runtimeError(INVALID_ARGUMENT, `Invalid counter ${key}`)
			next.counters[key as StoredCounter] = value
		}
	}
	if (edit.deckGames !== undefined) {
		if (!isFields(edit.deckGames)) throw runtimeError(INVALID_ARGUMENT, 'deckGames must be an object')
		for (const deck in edit.deckGames) {
			const value = edit.deckGames[deck]
			if ((VANILLA_DECKS as readonly string[]).indexOf(deck) === -1 || !isCount(value))
				throw runtimeError(INVALID_ARGUMENT, `Invalid deck ${deck}`)
			next.deckGames[deck] = value
		}
	}
	if (edit.spdrnModesPlayed !== undefined) {
		const modes = Array.isArray(edit.spdrnModesPlayed) ? edit.spdrnModesPlayed.map(spdrnModeOf) : [null]
		if (modes.some((m) => m === null)) throw runtimeError(INVALID_ARGUMENT, 'Invalid spdrnModesPlayed')
		next.spdrnModesPlayed = modes as SpdrnMode[]
	}
	if (edit.milestones !== undefined) {
		const list = edit.milestones
		if (!Array.isArray(list) || !list.every((m) => (MILESTONES as readonly string[]).indexOf(m as string) !== -1))
			throw runtimeError(INVALID_ARGUMENT, 'Invalid milestones')
		next.milestones = list as Milestone[]
	}
	if (edit.unlocked !== undefined) {
		if (!Array.isArray(edit.unlocked) || !edit.unlocked.every(isAvatarId)) throw runtimeError(INVALID_ARGUMENT, 'Invalid unlocked')
		next.unlocked = edit.unlocked as AvatarId[]
	}
	return next
}

// {userId, reset?, counters?, deckGames?, spdrnModesPlayed?, milestones?,
// unlocked?} -> {progress}. Testing only: sets a player just short of a goal
// so one real game crosses it. reset starts from empty progress. Earns
// nothing by itself.
export function rpcAdminProgressSet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string) {
	requireServer(ctx)
	if (!testingRpcsAllowed(ctx)) throw runtimeError(PERMISSION_DENIED, 'Testing RPCs are off on this server')
	const input = parsePayload(payload)
	if (typeof input.userId !== 'string' || !USER_ID.test(input.userId)) throw runtimeError(INVALID_ARGUMENT, 'Invalid userId')
	const userId = input.userId
	// Progress for an id with no player would be an orphan row.
	if (!readProfile(nk, userId)) throw runtimeError(NOT_FOUND, 'No such player')
	const { after } = updateProgress(nk, userId, (progress) => editedProgress(input.reset === true ? emptyProgress() : progress, input))
	logger.info('Achievement progress of %s set for testing', userId)
	return JSON.stringify({ progress: after })
}
