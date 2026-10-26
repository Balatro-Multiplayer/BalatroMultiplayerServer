// The server kind as Nakama sees it: the shared rules (packages/types) read
// from the runtime env. InitModule calls checkServerKind first, so a bad kind
// or a refused dev flag stops Nakama before anything registers; after that,
// settingsOf can only fail on a bug.
import {
	type ServerSettings,
	serverKindErrorMessage,
	serverSettings,
} from '../../packages/types/src/server-kind'

export { serverKindErrorMessage, serverSettings, type ServerSettings }

export function checkServerKind(
	env: { [key: string]: string },
	logger: nkruntime.Logger,
): ServerSettings {
	const result = serverSettings(env)
	if (!result.ok) {
		const message = serverKindErrorMessage(result.error)
		logger.error('Refusing to start: %s', message)
		throw new Error(message)
	}
	logger.info('BMP server kind: %s', result.value.kind)
	return result.value
}

export function settingsOf(ctx: nkruntime.Context): ServerSettings {
	const result = serverSettings(ctx.env)
	if (!result.ok) throw new Error(serverKindErrorMessage(result.error))
	return result.value
}
