import { describe, expect, it } from 'vitest'
import { ensureRatingBoard, syncLeaderboardEntry } from './board_sync'

const BOARD = 'MultiplayerPvP:pvp_ranked_vanilla:1'
const META = { modId: 'MultiplayerPvP', mode: 'pvp_ranked_vanilla' }
const silent = { warn: () => {} } as unknown as nkruntime.Logger

function recordingNk() {
	const created: unknown[][] = []
	const nk = {
		leaderboardCreate: (...args: unknown[]) => {
			created.push(args)
		},
		leaderboardRecordWrite: () => {},
		leaderboardRecordDelete: () => {},
	} as unknown as nkruntime.Nakama
	return { nk, created }
}

// Nakama (3.21+) keeps a board's ranks only when the board is created with
// enableRank; without it rating_get's owner lookup carries no rank. Every
// site that creates a rating board goes through ensureRatingBoard (apply.ts
// and legacy.ts pin that in their own tests).
describe('ensureRatingBoard', () => {
	it('creates the board authoritative, descending, set, with ranks enabled', () => {
		const { nk, created } = recordingNk()

		ensureRatingBoard(nk, BOARD, META)

		expect(created).toEqual([[BOARD, true, 'desc', 'set', null, META, true]])
	})
})

describe('syncLeaderboardEntry', () => {
	it('creates the board ranked before writing', () => {
		const { nk, created } = recordingNk()

		syncLeaderboardEntry(nk, silent, BOARD, META, 'user-1', 'TestPlayer1', null)

		expect(created).toEqual([[BOARD, true, 'desc', 'set', null, META, true]])
	})
})
