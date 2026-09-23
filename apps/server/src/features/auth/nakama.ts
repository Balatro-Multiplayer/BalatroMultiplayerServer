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
	user?: { id?: string; steam_id?: string }
}

export function isNakamaAuthEnabled(): boolean {
	return env.NAKAMA_URL !== ''
}

// Asks Nakama who a session token belongs to. Nakama checks the token itself,
// so the API needs no Nakama secret. Only accounts with a Steam identity are
// accepted: Nakama's device/custom/email auth is open to anyone, while a
// steam_id can only get onto an account through a Steam-verified ticket.
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
	if (!data.user.steam_id) return err('no_steam_identity')
	return ok({ userId: data.user.id, steamId: data.user.steam_id })
}
