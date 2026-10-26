import { env } from '../../env.js'
import { err, ok } from '../../shared/utils/result.js'
import type { Result } from '../../shared/utils/result.js'

// conflict: the RPC answered ALREADY_EXISTS (HTTP 409); not_found: NOT_FOUND
// (HTTP 404), such as an account that no longer exists.
export type NakamaRpcError = 'disabled' | 'unreachable' | 'rejected' | 'conflict' | 'not_found'

const TIMEOUT_MS = 5000

export function isNakamaAdminEnabled(): boolean {
	return env.NAKAMA_URL !== '' && env.NAKAMA_HTTP_KEY !== ''
}

// Calls one of Nakama's server-only admin RPCs (nakama/src/admin.ts) with the
// runtime http key. `unwrap` sends the body as-is rather than as a
// JSON-encoded string, and returns the RPC's own JSON.
export async function callNakamaRpc<T = unknown>(
	id: string,
	body: Record<string, unknown>,
): Promise<Result<T, NakamaRpcError>> {
	if (!isNakamaAdminEnabled()) return err('disabled')
	const url = `${env.NAKAMA_URL}/v2/rpc/${encodeURIComponent(id)}?http_key=${encodeURIComponent(env.NAKAMA_HTTP_KEY)}&unwrap`
	let response: Response
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
	} catch {
		return err('unreachable')
	}
	if (response.status === 409) return err('conflict')
	if (response.status === 404) return err('not_found')
	if (!response.ok) {
		console.warn(`[nakama] RPC ${id} failed: HTTP ${response.status} ${await response.text().catch(() => '')}`)
		return err('rejected')
	}
	try {
		return ok((await response.json()) as T)
	} catch {
		return err('rejected')
	}
}
