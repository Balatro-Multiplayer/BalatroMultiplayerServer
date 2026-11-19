import { Router } from 'express'
import {
	loadConfigFromDb,
	setRankedEnabled,
} from '../../infrastructure/gateways/config.gateway.js'
import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import { AppError } from '../../shared/utils/errors.js'
import { getConfig } from '../../state/config.js'
import { logDeployAction, readBody, requireReason } from './deploy-auth.js'

const CANCEL_NOTICE = 'Ranked is closed for a server update'

// Ranked switch and live count for a Full deploy: close, open, live. Mounted
// at /ranked on the deploy router, behind its token check.
export function createRankedDeployRouter() {
	const router = Router()

	async function setRankedAndLog(reason: string, enabled: boolean) {
		const before = getConfig().rankedEnabled
		await setRankedEnabled(enabled)
		await logDeployAction({
			action: 'config_change',
			reason,
			detail: {
				old: { rankedEnabled: before },
				new: { rankedEnabled: enabled },
			},
		})
		await loadConfigFromDb()
	}

	// {reason}: turns Ranked off, then cancels every ranked ticket (each player
	// gets the queue-cancelled notice). Casual tickets stay.
	router.post('/close', async (req, res) => {
		await setRankedAndLog(requireReason(readBody(req)), false)
		const cancelled = await callNakamaRpc<{ cancelled: number }>(
			'admin_ranked_queue_cancel',
			{ reason: CANCEL_NOTICE },
		)
		if (!cancelled.ok)
			throw new AppError(
				`Ranked is closed, but the queue cancel failed: ${cancelled.error}`,
				502,
			)
		res.json({ ok: true, cancelled: cancelled.value.cancelled })
	})

	// {reason}: turns Ranked on.
	router.post('/open', async (req, res) => {
		await setRankedAndLog(requireReason(readBody(req)), true)
		res.json({ ok: true })
	})

	// The started ranked matches, for the wait before a deploy.
	router.get('/live', async (_req, res) => {
		const live = await callNakamaRpc<{ running: number }>(
			'admin_ranked_live',
			{},
		)
		if (!live.ok)
			throw new AppError(`Could not count ranked matches: ${live.error}`, 502)
		res.json({ running: live.value.running })
	})

	return router
}
