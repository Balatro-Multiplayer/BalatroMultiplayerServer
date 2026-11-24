import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { db } from '../../infrastructure/db/index.js'
import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import {
	countInRange,
	getInstantRange,
	listInstantQueues,
	setInstantRange,
} from '../../infrastructure/gateways/instant-queue.gateway.js'
import { findPlayerById } from '../../infrastructure/gateways/player.gateway.js'
import { recordStaffAction } from '../../infrastructure/gateways/staff-log.gateway.js'
import { authenticateActive } from '../../middleware/authenticate-active.js'
import { parseReason } from '../../shared/staff-log/actions.js'
import { AppError } from '../../shared/utils/errors.js'
import { staffRoleOf } from '../../shared/utils/staff-role.js'
import {
	MAX_RANGE_RATING,
	isQueueName,
	parseRange,
} from '../instant-queue/ranges.js'

// The instant queue panel. Open to admins and to anyone holding the
// 'instaqueue' privilege, who need not be staff: it is mounted ahead of the
// staff gate (webadmin.route.ts) and checks for itself.
export const INSTANT_QUEUE_PRIVILEGE = 'instaqueue'

const router = Router()

type Editor = { playerId: string; role: 'admin' | 'instaqueue' }

async function editorOf(req: Request): Promise<Editor | null> {
	if (!req.player) return null
	const { playerId } = req.player
	const player = await findPlayerById(playerId)
	if (!player) return null
	if (staffRoleOf(playerId, player.privileges) === 'admin')
		return { playerId, role: 'admin' }
	if (player.privileges.includes(INSTANT_QUEUE_PRIVILEGE))
		return { playerId, role: 'instaqueue' }
	return null
}

function gate(req: Request, res: Response, next: NextFunction) {
	authenticateActive(req, res, async () => {
		try {
			const editor = await editorOf(req)
			if (!editor) {
				res.status(403).json({ error: 'Forbidden' })
				return
			}
			res.locals.instantQueueEditor = editor
			next()
		} catch (err) {
			next(err)
		}
	})
}

router.use('/instant-queue', gate)

router.get('/instant-queue', async (_req, res, next) => {
	try {
		const queues = await listInstantQueues()
		const withCounts = await Promise.all(
			queues.map(async (q) => ({
				...q,
				counts: await countInRange(
					q.modId,
					q.gameMode,
					q.range.floor,
					q.range.ceiling,
				),
			})),
		)
		res.json({ queues: withCounts })
	} catch (err) {
		next(err)
	}
})

function edgeOf(value: unknown): number | null {
	if (value === undefined || value === '') return null
	const n = Number(value)
	if (!Number.isInteger(n) || n < 0 || n > MAX_RANGE_RATING)
		throw new AppError(
			`Ratings are whole numbers from 0 to ${MAX_RANGE_RATING}`,
			400,
		)
	return n
}

// The player count of the edges being typed, before they are saved.
router.get('/instant-queue/count', async (req, res, next) => {
	try {
		const { modId, gameMode } = req.query
		if (!isQueueName(modId) || !isQueueName(gameMode))
			throw new AppError('modId and gameMode are required', 400)
		res.json(
			await countInRange(
				modId,
				gameMode,
				edgeOf(req.query.floor),
				edgeOf(req.query.ceiling),
			),
		)
	} catch (err) {
		next(err)
	}
})

router.put('/instant-queue/:modId/:gameMode', async (req, res, next) => {
	try {
		const { modId, gameMode } = req.params
		if (!isQueueName(modId) || !isQueueName(gameMode))
			throw new AppError('Not a queue name', 400)
		const parsed = parseRange(req.body)
		if (!parsed.ok) throw new AppError(parsed.message, 400)
		const reason = parseReason((req.body as { reason?: unknown }).reason)
		if (!reason.ok) throw new AppError(reason.message, 400)
		const editor = res.locals.instantQueueEditor as Editor
		const before = await getInstantRange(modId, gameMode)
		await db.transaction(async (tx) => {
			await setInstantRange(tx, modId, gameMode, parsed.range)
			await recordStaffAction(tx, {
				staff: { playerId: editor.playerId, role: editor.role },
				action: 'instant_queue_edit',
				reason: reason.reason,
				detail: { modId, gameMode, before, after: parsed.range },
			})
		})
		// Reloads the config, which pushes the new ranges to Nakama.
		await loadConfigFromDb()
		res.json({
			modId,
			gameMode,
			range: parsed.range,
			counts: await countInRange(
				modId,
				gameMode,
				parsed.range.floor,
				parsed.range.ceiling,
			),
		})
	} catch (err) {
		next(err)
	}
})

export default router
