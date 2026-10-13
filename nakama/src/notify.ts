import { SYSTEM_USER_ID } from './lobby/protocol'

// Pushes to a player's socket, as Nakama notifications. The client routes
// them by code (MPAPI networking/nakama_notify.lua); keep both lists in step.
export const NotifyCode = {
	CHALLENGE: 100,
	ACCOUNT_UPDATED: 101,
	BANNED: 102,
	QUEUE_CANCELLED: 103,
	CONFIG: 104,
	INTEGRITY: 105,
	KICKED: 106,
}

const CODES: number[] = Object.keys(NotifyCode).map((k) => (NotifyCode as { [k: string]: number })[k])

export function isNotifyCode(code: unknown): code is number {
	return typeof code === 'number' && CODES.indexOf(code) !== -1
}

// Nakama 3.41 refuses '' as a sender ("expects senderId to either be not
// set, empty string or a valid UUID", despite the message): server pushes
// come from the system user.
// Persistent notifications are also kept for players who are offline and
// listed for them at their next login; transient ones only reach live sockets.
export function notify(
	nk: nkruntime.Nakama,
	userId: string,
	code: number,
	subject: string,
	content: { [key: string]: unknown },
	persistent = false,
) {
	nk.notificationSend(userId, subject, content, code, SYSTEM_USER_ID, persistent)
}
