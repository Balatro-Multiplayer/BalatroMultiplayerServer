import { randomUUID } from 'node:crypto'
import type { ChallengeIssuance, ChallengeStrategy } from '../../shared/types/index.js'

export const DEV_ANSWER_PREFIX = 'dev:'

// Development only (env.DEV_FAKE_LAUNCHER_STRATEGY): a stand-in for the
// private ChallengeStrategy so the whole challenge round trip can run
// locally. The right answer is 'dev:<nonce>' - bare for login/periodic, as
// the signature of a ranked_readiness response. Never used in production:
// env.ts forces the flag off there, and a real strategy replaces it.
export function createDevChallengeStrategy(): ChallengeStrategy {
	return {
		async issue(): Promise<ChallengeIssuance> {
			return {
				nonce: randomUUID(),
				algorithm: 'dev',
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			}
		},
		async verify(_playerId, issuance, response): Promise<boolean> {
			const expected = DEV_ANSWER_PREFIX + issuance.nonce
			if (typeof response === 'string') return response === expected
			if (response && typeof response === 'object')
				return (response as { signature?: unknown }).signature === expected
			return false
		},
	}
}
