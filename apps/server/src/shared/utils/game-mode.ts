// Ranked game modes are `ranked:<mode>` (nakama/src/review/ranked.ts has the
// same rule for Nakama).
export function isRankedGameMode(gameMode: string): boolean {
	return gameMode.startsWith('ranked:')
}
