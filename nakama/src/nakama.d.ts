// The slice of Nakama's JavaScript runtime API (3.41) this module uses.
// Hand-written rather than pulling in heroiclabs/nakama-common: that package
// is only published from git, and this keeps the build dependency-free.
declare namespace nkruntime {
	interface Context {
		env: { [key: string]: string }
		userId: string
		username: string
		matchId: string
	}

	interface Logger {
		debug(format: string, ...params: unknown[]): void
		info(format: string, ...params: unknown[]): void
		warn(format: string, ...params: unknown[]): void
		error(format: string, ...params: unknown[]): void
	}

	interface HttpResponse {
		code: number
		headers: { [key: string]: string[] }
		body: string
	}

	interface Match {
		matchId: string
		authoritative: boolean
		label: string
		size: number
	}

	interface StorageReadRequest {
		collection: string
		key: string
		userId: string
	}

	interface StorageObject {
		collection: string
		key: string
		userId: string
		value: { [key: string]: unknown }
	}

	interface StorageWriteRequest {
		collection: string
		key: string
		userId: string
		value: { [key: string]: unknown }
		permissionRead: 0 | 1 | 2
		permissionWrite: 0 | 1
		// '*' writes only if the object doesn't exist yet (throws otherwise).
		version?: string
	}

	interface Nakama {
		httpRequest(
			url: string,
			method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head',
			headers: { [key: string]: string },
			body: string,
			timeout: number,
		): HttpResponse
		binaryToString(data: ArrayBuffer): string
		matchCreate(module: string, params: { [key: string]: unknown }): string
		matchGet(id: string): Match | null
		matchList(
			limit: number,
			authoritative: boolean | null,
			label: string | null,
			minSize: number | null,
			maxSize: number | null,
			query: string | null,
		): Match[]
		matchSignal(id: string, data: string): string
		storageRead(reads: StorageReadRequest[]): StorageObject[]
		storageWrite(writes: StorageWriteRequest[]): unknown
		storageDelete(deletes: StorageReadRequest[]): void
	}

	interface Presence {
		userId: string
		sessionId: string
		username: string
		node: string
	}

	interface MatchMessage {
		sender: Presence
		opCode: number
		data: ArrayBuffer
		reliable: boolean
		receiveTimeMs: number
	}

	interface MatchDispatcher {
		broadcastMessage(
			opCode: number,
			data: string,
			presences: Presence[] | null,
			sender: Presence | null,
			reliable: boolean,
		): void
		matchKick(presences: Presence[]): void
		matchLabelUpdate(label: string): void
	}

	type MatchState = { [key: string]: unknown }

	interface MatchHandler<S extends MatchState> {
		matchInit(
			ctx: Context,
			logger: Logger,
			nk: Nakama,
			params: { [key: string]: unknown },
		): { state: S; tickRate: number; label: string }
		matchJoinAttempt(
			ctx: Context,
			logger: Logger,
			nk: Nakama,
			dispatcher: MatchDispatcher,
			tick: number,
			state: S,
			presence: Presence,
			metadata: { [key: string]: string },
		): { state: S; accept: boolean; rejectMessage?: string } | null
		matchJoin(
			ctx: Context,
			logger: Logger,
			nk: Nakama,
			dispatcher: MatchDispatcher,
			tick: number,
			state: S,
			presences: Presence[],
		): { state: S } | null
		matchLeave(
			ctx: Context,
			logger: Logger,
			nk: Nakama,
			dispatcher: MatchDispatcher,
			tick: number,
			state: S,
			presences: Presence[],
		): { state: S } | null
		matchLoop(
			ctx: Context,
			logger: Logger,
			nk: Nakama,
			dispatcher: MatchDispatcher,
			tick: number,
			state: S,
			messages: MatchMessage[],
		): { state: S } | null
		matchTerminate(
			ctx: Context,
			logger: Logger,
			nk: Nakama,
			dispatcher: MatchDispatcher,
			tick: number,
			state: S,
			graceSeconds: number,
		): { state: S } | null
		matchSignal(
			ctx: Context,
			logger: Logger,
			nk: Nakama,
			dispatcher: MatchDispatcher,
			tick: number,
			state: S,
			data: string,
		): { state: S; data?: string } | null
	}

	interface AuthenticateCustomRequest {
		account?: { id?: string; vars?: { [key: string]: string } }
		create?: boolean
		username?: string
	}

	interface AuthenticateDeviceRequest {
		account?: { id?: string; vars?: { [key: string]: string } }
		create?: boolean
		username?: string
	}

	interface AccountCustom {
		id?: string
		vars?: { [key: string]: string }
	}

	type BeforeHookFunction<T> = (
		ctx: Context,
		logger: Logger,
		nk: Nakama,
		data: T,
	) => T | undefined
	type RpcFunction = (
		ctx: Context,
		logger: Logger,
		nk: Nakama,
		payload: string,
	) => string | undefined

	interface Initializer {
		registerBeforeAuthenticateCustom(
			fn: BeforeHookFunction<AuthenticateCustomRequest>,
		): void
		registerBeforeAuthenticateDevice(
			fn: BeforeHookFunction<AuthenticateDeviceRequest>,
		): void
		registerBeforeLinkCustom(fn: BeforeHookFunction<AccountCustom>): void
		registerBeforeUnlinkCustom(fn: BeforeHookFunction<AccountCustom>): void
		registerRpc(id: string, fn: RpcFunction): void
		registerMatch<S extends MatchState>(
			name: string,
			handler: MatchHandler<S>,
		): void
	}

	interface Error {
		code: number
		message: string
	}
}
