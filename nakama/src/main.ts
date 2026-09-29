// Nakama JavaScript runtime entry point (bundled to modules/index.js by
// build.mjs). Nakama resolves every function registered here by its name in
// the script's global scope, so they are passed as plain identifiers.
import {
	beforeAuthenticateCustom,
	beforeAuthenticateDevice,
	refuseCustomIdChange,
} from './auth'
import {
	lobbyMatchInit,
	lobbyMatchJoin,
	lobbyMatchJoinAttempt,
	lobbyMatchLeave,
	lobbyMatchLoop,
	lobbyMatchSignal,
	lobbyMatchTerminate,
} from './lobby/match'
import {
	rpcLobbyCreate,
	rpcLobbyCurrent,
	rpcLobbyFind,
	rpcLobbyLeave,
	rpcRunActive,
} from './lobby/rpc'
import { matchmakerMatched } from './matchmaking/matched'
import { rpcLeaderboardGet, rpcRatingGet } from './rating/rpc'
import { rpcRunGet, rpcRunLogs, rpcRunsMine } from './lobby/storage'

function InitModule(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	initializer: nkruntime.Initializer,
) {
	initializer.registerBeforeAuthenticateCustom(beforeAuthenticateCustom)
	initializer.registerBeforeLinkCustom(refuseCustomIdChange)
	initializer.registerBeforeUnlinkCustom(refuseCustomIdChange)
	initializer.registerBeforeAuthenticateDevice(beforeAuthenticateDevice)
	logger.info('BMP Steam login module loaded')

	// Literal, not LOBBY_MATCH: Nakama reads the registration calls from this
	// function's source, so the name must be spelled out here.
	initializer.registerMatch('bmp_lobby', {
		matchInit: lobbyMatchInit,
		matchJoinAttempt: lobbyMatchJoinAttempt,
		matchJoin: lobbyMatchJoin,
		matchLeave: lobbyMatchLeave,
		matchLoop: lobbyMatchLoop,
		matchSignal: lobbyMatchSignal,
		matchTerminate: lobbyMatchTerminate,
	})
	initializer.registerMatchmakerMatched(matchmakerMatched)
	initializer.registerRpc('lobby_create', rpcLobbyCreate)
	initializer.registerRpc('lobby_find', rpcLobbyFind)
	initializer.registerRpc('lobby_current', rpcLobbyCurrent)
	initializer.registerRpc('lobby_leave', rpcLobbyLeave)
	initializer.registerRpc('run_active', rpcRunActive)
	initializer.registerRpc('run_get', rpcRunGet)
	initializer.registerRpc('run_logs', rpcRunLogs)
	initializer.registerRpc('runs_mine', rpcRunsMine)
	initializer.registerRpc('rating_get', rpcRatingGet)
	initializer.registerRpc('leaderboard_get', rpcLeaderboardGet)
	logger.info('BMP lobby module loaded')
}

// Nothing calls InitModule inside the bundle; this reference keeps esbuild
// from tree-shaking it away (Nakama calls it by name).
// @ts-ignore
!InitModule && InitModule.bind(null)
