// {} -> StandingResult: the caller's standing, for the main-menu badge and to
// grey out the queues it can't use. profile_set_mods answers with the same
// view (player/rpc.ts), so a client needs this only after a 105 or 108.
import { requireUser } from '../rpc'
import { standingFor } from './current'
import { settingsOf } from '../server_kind'

export function rpcAccountStanding(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	return JSON.stringify(standingFor(nk, settingsOf(ctx), userId, Date.now()))
}
