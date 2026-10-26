// The server kind (BMP_SERVER_KIND) and the dev flags it allows. Nakama
// (nakama/src/server_kind.ts) and the API (apps/server/src/env.ts) both read
// it at startup and refuse to start when it fails, so a dev flag can never
// reach the Official server.
//
// - official: Steam login only; every dev flag is refused; a mod report must
//   list only allowed mods. An unset kind is official, so forgetting the
//   setting fails safe.
// - community: Device login on; the dev-only flags are refused; chat is
//   judged by the local word filter unless MODERATION_REMOTE=on; any mod may
//   queue.
// - dev: every dev flag is allowed and overrides the dev defaults.
//
// Plain ES2015 with no imports: the Nakama bundle includes this file too.

export const SERVER_KINDS = ['official', 'community', 'dev'] as const
export type ServerKind = (typeof SERVER_KINDS)[number]

export const DEV_FLAGS = [
	'ALLOW_DEVICE_AUTH',
	'ALLOW_RANKED_LOBBIES',
	'DEV_AUTO_VERIFY_LAUNCHER',
	'DEV_FAKE_LAUNCHER_STRATEGY',
] as const
export type DevFlag = (typeof DEV_FLAGS)[number]

export interface ServerSettings {
	kind: ServerKind
	deviceLogin: boolean
	rankedLobbies: boolean
	autoVerifyLauncher: boolean
	fakeLauncherStrategy: boolean
	moderationRemote: boolean
	testingRpcs: boolean
	// Whether a mod report may list only the allowed mods (standing/).
	allowedModsChecked: boolean
}

export type ServerKindError =
	| { code: 'unknown_kind'; value: string }
	| { code: 'dev_flag_not_allowed'; kind: ServerKind; flags: DevFlag[] }

export type ServerSettingsResult =
	| { ok: true; value: ServerSettings }
	| { ok: false; error: ServerKindError }

type Env = { [key: string]: string | undefined }

// The dev flags a kind refuses when they are switched on.
const REFUSED_FLAGS: { [kind in ServerKind]: readonly DevFlag[] } = {
	official: DEV_FLAGS,
	community: [
		'ALLOW_RANKED_LOBBIES',
		'DEV_AUTO_VERIFY_LAUNCHER',
		'DEV_FAKE_LAUNCHER_STRATEGY',
	],
	dev: [],
}

// true/1 = on, false/0 = off, anything else = not set.
function flag(env: Env, key: string): boolean | undefined {
	const value = env[key]
	if (value === 'true' || value === '1') return true
	if (value === 'false' || value === '0') return false
	return undefined
}

function isServerKind(value: string): value is ServerKind {
	return (SERVER_KINDS as readonly string[]).indexOf(value) !== -1
}

export function serverSettings(env: Env): ServerSettingsResult {
	const raw = env.BMP_SERVER_KIND || 'official'
	if (!isServerKind(raw))
		return { ok: false, error: { code: 'unknown_kind', value: raw } }
	const kind = raw

	const refused = REFUSED_FLAGS[kind].filter((key) => flag(env, key) === true)
	if (refused.length > 0)
		return {
			ok: false,
			error: { code: 'dev_flag_not_allowed', kind, flags: refused },
		}

	const moderation = env.MODERATION_REMOTE
	const moderationRemote =
		moderation === 'off'
			? false
			: moderation === 'on'
				? true
				: kind === 'official'

	if (kind === 'dev') {
		return {
			ok: true,
			value: {
				kind,
				deviceLogin: flag(env, 'ALLOW_DEVICE_AUTH') !== false,
				rankedLobbies: flag(env, 'ALLOW_RANKED_LOBBIES') !== false,
				autoVerifyLauncher: flag(env, 'DEV_AUTO_VERIFY_LAUNCHER') === true,
				fakeLauncherStrategy: flag(env, 'DEV_FAKE_LAUNCHER_STRATEGY') === true,
				moderationRemote,
				testingRpcs: true,
				allowedModsChecked: false,
			},
		}
	}
	return {
		ok: true,
		value: {
			kind,
			deviceLogin: kind === 'community',
			rankedLobbies: false,
			autoVerifyLauncher: false,
			fakeLauncherStrategy: false,
			moderationRemote,
			testingRpcs: false,
			allowedModsChecked: kind === 'official',
		},
	}
}

export function serverKindErrorMessage(error: ServerKindError): string {
	if (error.code === 'unknown_kind')
		return `BMP_SERVER_KIND="${error.value}" is not a server kind; use one of: ${SERVER_KINDS.join(', ')}`
	return `BMP_SERVER_KIND=${error.kind} refuses ${error.flags.join(', ')}: dev flags need BMP_SERVER_KIND=dev`
}
