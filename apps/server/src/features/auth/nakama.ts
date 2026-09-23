import { env } from '../../env.js'
import { err, ok } from '../../shared/utils/result.js'
import type { Result } from '../../shared/utils/result.js'

export interface NakamaAccount {
	userId: string
	steamId: string
}

export type NakamaAccountError =
	| 'invalid_session'
	| 'no_steam_identity'
	| 'api_error'

interface NakamaAccountResponse {
	user?: { id?: string }
	custom_id?: string
}

// Nakama's Steam login (nakama/modules/index.js) signs players in under this
// custom id once it has verified their Steam ticket.
const STEAM_CUSTOM_ID = /^steam:(\d+)$/

export function isNakamaAuthEnabled(): boolean {
	return env.NAKAMA_URL !== ''
}

// Asks Nakama who a session token belongs to. Nakama checks the token itself,
// so the API needs no Nakama secret. Only accounts with a "steam:<id>" custom
// id are accepted: Nakama's device/email auth is open to anyone, while its
// runtime module only sets such a custom id after verifying a Steam ticket
// (and refuses every other way of setting a custom id).
export async function fetchNakamaAccount(
	sessionToken: string,
): Promise<Result<NakamaAccount, NakamaAccountError>> {
	let response: Response
	try {
		response = await fetch(`${env.NAKAMA_URL}/v2/account`, {
			headers: { Authorization: `Bearer ${sessionToken}` },
		})
	} catch {
		return err('api_error')
	}
	if (response.status === 401) return err('invalid_session')
	if (!response.ok) return err('api_error')

	const data = (await response.json()) as NakamaAccountResponse
	if (!data.user?.id) return err('api_error')
	const steamId = STEAM_CUSTOM_ID.exec(data.custom_id ?? '')?.[1]
	if (!steamId) return err('no_steam_identity')
	return ok({ userId: data.user.id, steamId })
}
