// The Announcement: one chat line to every player online at this moment
// (glossary). Transient, so a player who is offline never sees it.
import { INVALID_ARGUMENT, runtimeError } from './errors'
import { NotifyCode } from './notify'
import { parsePayload, requireServer } from './rpc'

export const ANNOUNCEMENT_MAX_LENGTH = 300

// {text} -> {ok}: server to server only. Nakama sends one transient
// notification to every connected session.
export function rpcAdminAnnounce(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const input = parsePayload(payload)
	const text = typeof input.text === 'string' ? input.text.trim() : ''
	if (!text) throw runtimeError(INVALID_ARGUMENT, 'text is required')
	if (text.length > ANNOUNCEMENT_MAX_LENGTH)
		throw runtimeError(INVALID_ARGUMENT, `text is over ${ANNOUNCEMENT_MAX_LENGTH} characters`)
	nk.notificationSendAll('announcement', { text }, NotifyCode.ANNOUNCEMENT, false)
	logger.info('Announcement sent (%d characters)', text.length)
	return JSON.stringify({ ok: true })
}
