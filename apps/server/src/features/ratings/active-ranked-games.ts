import type { NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import { isRankedGameMode } from '../../shared/utils/game-mode.js'
import { type Result, ok } from '../../shared/utils/result.js'
import type { ReplayCall } from './season-replay.service.js'

// admin_lobby_list's cap (LOBBY_LIST_LIMIT in nakama/src/admin.ts).
const LOBBY_LIST_LIMIT = 100

// Ranked games that have started and not ended, from Nakama's lobby list. A
// lobby label's `type` is public or private; a ranked lobby has a ranked game
// mode. A list at the cap may be cut off, so it counts as a running game: the
// apply refuses.
export async function activeRankedGames(
	call: ReplayCall,
): Promise<Result<number, NakamaRpcError>> {
	const lobbies = await call<{
		lobbies: { mode?: string; started: boolean }[]
	}>('admin_lobby_list', {})
	if (!lobbies.ok) return lobbies
	const list = lobbies.value.lobbies
	if (list.length >= LOBBY_LIST_LIMIT) return ok(list.length)
	return ok(
		list.filter((l) => l.started && isRankedGameMode(l.mode ?? '')).length,
	)
}
