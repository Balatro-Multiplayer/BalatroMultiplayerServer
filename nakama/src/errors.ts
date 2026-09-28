// Nakama's gRPC status codes, as the client sees them.
export const INVALID_ARGUMENT = 3
export const NOT_FOUND = 5
export const ALREADY_EXISTS = 6
export const PERMISSION_DENIED = 7
export const FAILED_PRECONDITION = 9
export const UNAVAILABLE = 14
export const UNAUTHENTICATED = 16

export function runtimeError(code: number, message: string): nkruntime.Error {
	return { code, message }
}
