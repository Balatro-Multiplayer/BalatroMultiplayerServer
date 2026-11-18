import type { RequestHandler } from 'express'
import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import { parseReason } from '../../shared/staff-log/actions.js'
import { AppError } from '../../shared/utils/errors.js'
import { logDeployAction } from './deploy-auth.js'

// Same limit as Nakama's admin_announce, so a long text fails here with a 400.
export const ANNOUNCEMENT_MAX_LENGTH = 300

// {text, reason}: sends an Announcement (one chat line to every online
// player, not stored) and logs it as done by the deploy token.
export const announce: RequestHandler = async (req, res, next) => {
	try {
		const { text: raw, reason } = (req.body ?? {}) as Record<string, unknown>
		const text = typeof raw === 'string' ? raw.trim() : ''
		if (!text) throw new AppError('text is required', 400)
		if (text.length > ANNOUNCEMENT_MAX_LENGTH)
			throw new AppError(
				`text is over ${ANNOUNCEMENT_MAX_LENGTH} characters`,
				400,
			)
		const checked = parseReason(reason)
		if (!checked.ok) throw new AppError(checked.message, 400)

		const sent = await callNakamaRpc('admin_announce', { text })
		if (!sent.ok) throw new AppError('Nakama could not send it', 502)
		await logDeployAction({
			action: 'announcement',
			reason: checked.reason,
			detail: { text },
		})
		res.json({ ok: true })
	} catch (err) {
		next(err)
	}
}
