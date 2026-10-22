// The pre-queue routes (/reports/:id/resolve, /match-conflicts/:id/resolve,
// /forfeit-reconciliation/:id/void|dismiss) run through the dispatcher when
// their source row has a queue item, so the queue row, the source and the
// audit trail stay in step and the role table applies. A row with no item
// (from before the queue) falls back to the direct write.
import type { Request } from 'express'
import { findServiceQueueItem } from '../../infrastructure/gateways/service-queue.gateway.js'
import { httpOf } from './refusals.js'
import { serviceQueueDispatcher } from './queue.service.js'
import { staffOf } from './staff.js'
import type { ActionKey, ItemType } from './types.js'

export type LegacyDispatch =
	| { kind: 'no_item' }
	| { kind: 'done' }
	| { kind: 'refused'; status: number; body: Record<string, unknown> }

export async function dispatchLegacy(
	req: Request,
	itemType: ItemType,
	sourceId: number,
	action: ActionKey,
): Promise<LegacyDispatch> {
	const item = await findServiceQueueItem(itemType, String(sourceId))
	if (!item) return { kind: 'no_item' }
	const staff = await staffOf(req)
	if (!staff) return { kind: 'refused', ...httpOf({ code: 'forbidden' }) }
	const result = await serviceQueueDispatcher.run(item.id, action, staff, (req.body ?? {}) as Record<string, unknown>)
	if (!result.ok) return { kind: 'refused', ...httpOf(result.refusal) }
	return { kind: 'done' }
}
