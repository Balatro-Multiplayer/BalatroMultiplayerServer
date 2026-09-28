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
} from './lobby/rpc'

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
	initializer.registerRpc('lobby_create', rpcLobbyCreate)
	initializer.registerRpc('lobby_find', rpcLobbyFind)
	initializer.registerRpc('lobby_current', rpcLobbyCurrent)
	initializer.registerRpc('lobby_leave', rpcLobbyLeave)
	logger.info('BMP lobby module loaded')
}

// Nothing calls InitModule inside the bundle; this reference keeps esbuild
// from tree-shaking it away (Nakama calls it by name).
// @ts-ignore
!InitModule && InitModule.bind(null)
