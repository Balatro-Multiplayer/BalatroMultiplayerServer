import { Router } from 'express'
import type { Response } from 'express'
import { db } from '../../infrastructure/db/index.js'
import {
	type QueueSort,
	type QueueStatusFilter,
	getServiceQueueItemById,
	isServiceQueueItemType,
	listItemEvents,
	listServiceQueueItems,
	openCountsByType,
	recordItemEvent,
	viewedSince,
} from '../../infrastructure/gateways/service-queue.gateway.js'
import { MAX_PAGE, queryInt } from '../../shared/utils/query-int.js'
import { activeClaimant } from '../service-queue/claim.js'
import { evidenceOf, subjectCard } from '../service-queue/evidence/assemble.js'
import { allowedActionsFor } from '../service-queue/permissions.js'
import { claim, release, serviceQueueDispatcher } from '../service-queue/queue.service.js'
import { type QueueRefusal, httpOf } from '../service-queue/refusals.js'
import { staffOf } from '../service-queue/staff.js'
import { type ItemStatus, type ItemType, actorOf, isItemType } from '../service-queue/types.js'

// The moderator service queue (Q-api.md documents every route and shape).
const router = Router()

// A detail view is recorded once per staff member per this window.
const VIEW_WINDOW_MS = 10 * 60 * 1000

function sendRefusal(res: Response, refusal: QueueRefusal) {
	const { status, body } = httpOf(refusal)
	res.status(status).json(body)
}

function itemIdOf(raw: string): number | null {
	const id = Number(raw)
	return Number.isInteger(id) && id > 0 ? id : null
}

function claimOf(item: { claimedBy: string | null; claimedUntil: Date | null }, now: Date) {
	const holder = activeClaimant(item, now)
	return holder ? { claimedBy: holder, claimedUntil: item.claimedUntil } : null
}

const STATUS_FILTERS: readonly QueueStatusFilter[] = ['open', 'resolved', 'all']

router.get('/service-queue', async (req, res, next) => {
	try {
		const page = queryInt(req.query.page, 1, 1, MAX_PAGE)
		const limit = queryInt(req.query.limit, 50, 1, 100)
		const itemType = isServiceQueueItemType(req.query.itemType) ? req.query.itemType : undefined
		// Unfiltered (the old default) is every status.
		const status = STATUS_FILTERS.find((s) => s === req.query.status) ?? 'all'
		const sort: QueueSort = req.query.sort === 'age' ? 'age' : 'priority'
		const subject =
			typeof req.query.subject === 'string' && req.query.subject.trim() ? req.query.subject.trim() : undefined
		const olderThanHours = queryInt(req.query.olderThanHours, 0, 0, 24 * 365)
		const claimedByMe = req.query.claimedByMe === '1' || req.query.claimedByMe === 'true'
		const now = new Date()

		const [{ items, total }, counts] = await Promise.all([
			listServiceQueueItems({
				page,
				limit,
				itemType,
				status,
				subject,
				claimedBy: claimedByMe ? req.player!.playerId : undefined,
				olderThanMs: olderThanHours > 0 ? olderThanHours * 60 * 60 * 1000 : undefined,
				sort,
				now,
			}),
			openCountsByType(),
		])
		res.json({
			items: items.map((item) => ({ ...item, claim: claimOf(item, now) })),
			total,
			page,
			limit,
			pages: Math.ceil(total / limit),
			counts,
		})
	} catch (err) {
		next(err)
	}
})

router.get('/service-queue/:id', async (req, res, next) => {
	try {
		const id = itemIdOf(req.params.id)
		if (id === null) return sendRefusal(res, { code: 'not_found' })
		const staff = await staffOf(req)
		if (!staff) return sendRefusal(res, { code: 'forbidden' })
		const item = await getServiceQueueItemById(id)
		if (!item || !isItemType(item.itemType)) return sendRefusal(res, { code: 'not_found' })

		const now = new Date()
		const [subject, evidence] = await Promise.all([subjectCard(item.subjectPlayerId, item, now), evidenceOf(item, now)])
		const actor = actorOf(staff.role, staff.playerId)
		if (!(await viewedSince(item.id, actor, new Date(now.getTime() - VIEW_WINDOW_MS))))
			await recordItemEvent(db, { itemId: item.id, kind: 'viewed', actor })

		res.json({
			item,
			subject,
			evidence,
			allowedActions: allowedActionsFor(
				{ itemType: item.itemType as ItemType, status: item.status as ItemStatus },
				staff.role,
			),
			role: staff.role,
			claim: claimOf(item, now),
		})
	} catch (err) {
		next(err)
	}
})

router.get('/service-queue/:id/events', async (req, res, next) => {
	try {
		const id = itemIdOf(req.params.id)
		if (id === null) return sendRefusal(res, { code: 'not_found' })
		const item = await getServiceQueueItemById(id)
		if (!item) return sendRefusal(res, { code: 'not_found' })
		res.json({ events: await listItemEvents(id) })
	} catch (err) {
		next(err)
	}
})

router.post('/service-queue/:id/claim', async (req, res, next) => {
	try {
		const id = itemIdOf(req.params.id)
		if (id === null) return sendRefusal(res, { code: 'not_found' })
		const staff = await staffOf(req)
		if (!staff) return sendRefusal(res, { code: 'forbidden' })
		const result = await claim(id, staff)
		if (!result.ok) return sendRefusal(res, result.refusal)
		res.json({ item: result.value, claim: claimOf(result.value, new Date()) })
	} catch (err) {
		next(err)
	}
})

router.delete('/service-queue/:id/claim', async (req, res, next) => {
	try {
		const id = itemIdOf(req.params.id)
		if (id === null) return sendRefusal(res, { code: 'not_found' })
		const staff = await staffOf(req)
		if (!staff) return sendRefusal(res, { code: 'forbidden' })
		const force = req.query.force === '1' || req.query.force === 'true'
		const result = await release(id, staff, force)
		if (!result.ok) return sendRefusal(res, result.refusal)
		res.json({ item: result.value, claim: claimOf(result.value, new Date()) })
	} catch (err) {
		next(err)
	}
})

// POST is the action route; PATCH is kept for the old web client.
for (const method of ['post', 'patch'] as const) {
	router[method]('/service-queue/:id/actions/:action', async (req, res, next) => {
		try {
			const id = itemIdOf(req.params.id)
			if (id === null) return sendRefusal(res, { code: 'not_found' })
			const staff = await staffOf(req)
			if (!staff) return sendRefusal(res, { code: 'forbidden' })
			const result = await serviceQueueDispatcher.run(
				id,
				req.params.action,
				staff,
				(req.body ?? {}) as Record<string, unknown>,
			)
			if (!result.ok) return sendRefusal(res, result.refusal)
			const { item, action, effects } = result.value
			console.log(`[webadmin] ${staff.role}:${staff.playerId} ran service-queue action '${action}' on item ${id}`)
			res.json({
				item,
				action,
				effects,
				allowedActions: allowedActionsFor(
					{ itemType: item.itemType as ItemType, status: item.status as ItemStatus },
					staff.role,
				),
			})
		} catch (err) {
			next(err)
		}
	})
}

export default router
