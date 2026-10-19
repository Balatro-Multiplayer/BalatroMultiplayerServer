// A player's achievement progress in Nakama storage: owned by the player
// (they can read it), written only by the server, with versioned writes
// retried on a concurrent change (as player/profile.ts does).
import type { Holdings } from '../shared/avatars/unlocked'
import { emptyProgress, progressOf, type Progress } from './progress'

export const PROGRESS_COLLECTION = 'avatar_progress'
export const PROGRESS_KEY = 'progress'

const WRITE_ATTEMPTS = 3

export interface StoredProgress {
	progress: Progress
	version: string
}

export function readProgress(nk: nkruntime.Nakama, userId: string): StoredProgress | null {
	const objects = nk.storageRead([{ collection: PROGRESS_COLLECTION, key: PROGRESS_KEY, userId }])
	if (objects.length === 0) return null
	return { progress: progressOf(objects[0].value), version: objects[0].version || '' }
}

export function progressFor(nk: nkruntime.Nakama, userId: string): Progress {
	const stored = readProgress(nk, userId)
	return stored ? stored.progress : emptyProgress()
}

export function writeProgress(nk: nkruntime.Nakama, userId: string, progress: Progress, version?: string) {
	nk.storageWrite([
		{
			collection: PROGRESS_COLLECTION,
			key: PROGRESS_KEY,
			userId,
			value: progress as unknown as { [key: string]: unknown },
			version,
			permissionRead: 1,
			permissionWrite: 0,
		},
	])
}

// Applies change to the stored progress (empty when there is none), retrying
// on a concurrent write. Unchanged progress (change returns its argument) is
// not written. Returns the progress before and after.
export function updateProgress(
	nk: nkruntime.Nakama,
	userId: string,
	change: (progress: Progress) => Progress,
): { before: Progress; after: Progress } {
	let lastError: unknown = null
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const stored = readProgress(nk, userId)
		const before = stored ? stored.progress : emptyProgress()
		const after = change(before)
		if (after === before) return { before, after }
		try {
			writeProgress(nk, userId, after, stored ? stored.version : '*')
			return { before, after }
		} catch (e) {
			lastError = e
		}
	}
	throw lastError
}

export function deleteProgress(nk: nkruntime.Nakama, userId: string) {
	nk.storageDelete([{ collection: PROGRESS_COLLECTION, key: PROGRESS_KEY, userId }])
}

// What the player may pick from: their privileges and earned avatars.
export function holdingsOf(nk: nkruntime.Nakama, userId: string, privileges: readonly string[]): Holdings {
	return { privileges, unlocked: progressFor(nk, userId).unlocked }
}
