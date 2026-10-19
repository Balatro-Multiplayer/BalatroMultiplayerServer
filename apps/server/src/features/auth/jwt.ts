import jwt from 'jsonwebtoken'
import { env } from '../../env.js'
import type { JwtPayload } from '../../shared/types/index.js'

export function signJwt(payload: JwtPayload): string {
	return jwt.sign(payload, env.JWT_SECRET, {
		expiresIn: env.JWT_EXPIRES_IN as `${number}${'s' | 'm' | 'h' | 'd'}`,
	})
}

// A session token. The single-purpose tokens signed with the same secret
// (the ToS-pending token, the Discord link state) carry a `purpose` and are
// not sessions: accepting them would let a player who hasn't accepted the
// ToS use the site with their 10-minute ToS token.
export function verifyJwt(token: string): JwtPayload | null {
	try {
		const decoded = jwt.verify(token, env.JWT_SECRET)
		if (typeof decoded !== 'object' || decoded === null) return null
		if ('purpose' in decoded) return null
		if (typeof decoded.playerId !== 'string') return null
		return decoded as JwtPayload
	} catch {
		return null
	}
}

export function signTosPendingToken(playerId: string): string {
	return jwt.sign({ playerId, purpose: 'tos-accept' }, env.JWT_SECRET, {
		expiresIn: '10m',
	})
}

export function verifyTosPendingToken(token: string): string | null {
	try {
		const decoded = jwt.verify(token, env.JWT_SECRET) as {
			playerId: string
			purpose: string
		}
		if (decoded.purpose !== 'tos-accept') return null
		return decoded.playerId
	} catch {
		return null
	}
}
