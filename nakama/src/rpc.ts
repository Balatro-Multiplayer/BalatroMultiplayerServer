// Shared RPC plumbing: who may call, and how payloads are read.
import { INVALID_ARGUMENT, PERMISSION_DENIED, UNAUTHENTICATED, runtimeError } from './errors'

// The calling player's id. Player RPCs refuse calls without a session.
export function requireUser(ctx: nkruntime.Context): string {
	if (!ctx.userId) throw runtimeError(UNAUTHENTICATED, 'This RPC needs a player session')
	return ctx.userId
}

// Admin RPCs are server to server only: called with the runtime http key,
// which carries no player session. Any player session is refused.
export function requireServer(ctx: nkruntime.Context): void {
	if (ctx.userId) throw runtimeError(PERMISSION_DENIED, 'Only the server may call this RPC')
}

// The payload as a JSON object. Empty means {}; so does [], which is how
// Lua clients encode an empty table.
export function parsePayload(payload: string): { [key: string]: unknown } {
	if (!payload) return {}
	try {
		const data = JSON.parse(payload)
		if (Array.isArray(data) && data.length === 0) return {}
		if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data
	} catch (e) {
		// Falls through to the error below.
	}
	throw runtimeError(INVALID_ARGUMENT, 'Payload must be a JSON object')
}
