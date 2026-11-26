// One player's leaderboard record, made to match their stored rating. A
// player with their placement games behind them is on the board; others are
// not (the legacy leaderboard also hides everyone under 5 games).
import type { RatingRecord } from './apply'
import { PLACEMENT_GAMES } from './elo'

// Every rating board is created here: authoritative, descending, 'set', no
// reset, and ranked. Nakama keeps a board in its rank cache only when the
// board was created with ranks enabled; otherwise a player's own record
// (rating_get's owner lookup) comes back without a rank. Board config is
// immutable, so a board created without the flag needs `enable_ranks` flipped
// in the leaderboard table and a Nakama restart.
export function ensureRatingBoard(nk: nkruntime.Nakama, board: string, metadata: { modId: string; mode: string }): void {
	nk.leaderboardCreate(board, true, 'desc', 'set', null, metadata, true)
}

export function syncLeaderboardEntry(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	board: string,
	metadata: { modId: string; mode: string },
	userId: string,
	name: string,
	record: RatingRecord | null,
): void {
	try {
		ensureRatingBoard(nk, board, metadata)
		if (record && record.gamesPlayed >= PLACEMENT_GAMES) {
			nk.leaderboardRecordWrite(
				board,
				userId,
				name,
				record.rating,
				record.wins,
				{
					losses: record.losses,
					gamesPlayed: record.gamesPlayed,
					seasonBest: record.seasonBest,
				},
				'set',
			)
		} else {
			try {
				nk.leaderboardRecordDelete(board, userId)
			} catch (err) {
				// Never on the board.
			}
		}
	} catch (e) {
		logger.warn('Leaderboard update on %s for %s failed: %v', board, userId, e)
	}
}
