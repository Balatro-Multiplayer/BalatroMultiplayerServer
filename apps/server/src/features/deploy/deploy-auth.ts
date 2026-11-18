import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { env } from '../../env.js'
import { db } from '../../infrastructure/db/index.js'
import { recordStaffAction } from '../../infrastructure/gateways/staff-log.gateway.js'
import {
	DEPLOY_ACTOR_ID,
	DEPLOY_ROLE,
	type StaffActionEntry,
} from '../../shared/staff-log/actions.js'

// Guards every /api/deploy route. With no DEPLOY_TOKEN the routes do not
// exist as far as a caller can tell (404). Otherwise the call must carry
// `Authorization: Bearer <DEPLOY_TOKEN>`, compared in constant time.
export function requireDeployToken(
	req: Request,
	res: Response,
	next: NextFunction,
) {
	if (!env.DEPLOY_TOKEN) {
		res.status(404).json({ error: 'Not found' })
		return
	}
	const header = req.headers.authorization
	if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
		res.status(401).json({ error: 'Missing deploy token' })
		return
	}
	const expected = Buffer.from(env.DEPLOY_TOKEN)
	const actual = Buffer.from(header.slice('Bearer '.length))
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		res.status(403).json({ error: 'Bad deploy token' })
		return
	}
	next()
}

// Writes the staff log entry for an action taken with the deploy token: the
// actor is "deploy", the reason is the one the caller sent.
export async function logDeployAction(
	entry: Omit<StaffActionEntry, 'staff'>,
): Promise<void> {
	await recordStaffAction(db, {
		...entry,
		staff: { playerId: DEPLOY_ACTOR_ID, role: DEPLOY_ROLE },
	})
}
