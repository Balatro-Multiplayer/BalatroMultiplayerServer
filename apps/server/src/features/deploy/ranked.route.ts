import { Router } from 'express'
import { setRankedEnabled, loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import { parseReason } from '../../shared/staff-log/actions.js'
import { AppError } from '../../shared/utils/errors.js'
import { getConfig } from '../../state/config.js'
import { logDeployAction } from './deploy-auth.js'

const CANCEL_NOTICE = 'Ranked is closed for a server update'

// Ranked switch and live count for a Full deploy: close, open, live. Mounted
// at /ranked on the deploy router, behind its token check.
export function createRankedDeployRouter() {
	const router = Router()

	async function switchRanked(body: unknown, enabled: boolean) {
		const checked = parseReason((body as { reason?: unknown } | undefined)?.reason)
		if (!checked.ok) throw new AppError(checked.message, 400)
		const before = getConfig().rankedEnabled
		await setRankedEnabled(enabled)
		await logDeployAction({
			action: 'config_change',
			reason: checked.reason,
			detail: { old: { rankedEnabled: before }, new: { rankedEnabled: enabled } },
		})
		await loadConfigFromDb()
	}

	// {reason}: turns Ranked off, then cancels every ranked ticket (each player
	// gets the queue-cancelled notice). Casual tickets stay.
	router.post('/close', async (req, res, next) => {
		try {
			await switchRanked(req.body, false)
			const cancelled = await callNakamaRpc<{ cancelled: number }>(
				'admin_ranked_queue_cancel',
				{ reason: CANCEL_NOTICE },
			)
			if (!cancelled.ok)
				throw new AppError(`Ranked is closed, but the queue cancel failed: ${cancelled.error}`, 502)
			res.json({ ok: true, cancelled: cancelled.value.cancelled })
		} catch (err) {
			next(err)
		}
	})

	// {reason}: turns Ranked on.
	router.post('/open', async (req, res, next) => {
		try {
			await switchRanked(req.body, true)
			res.json({ ok: true })
		} catch (err) {
			next(err)
		}
	})

	// The started ranked matches, for the wait before a deploy.
	router.get('/live', async (_req, res, next) => {
		try {
			const live = await callNakamaRpc<{ running: number }>('admin_ranked_live', {})
			if (!live.ok) throw new AppError(`Could not count ranked matches: ${live.error}`, 502)
			res.json({ running: live.value.running })
		} catch (err) {
			next(err)
		}
	})

	return router
}
