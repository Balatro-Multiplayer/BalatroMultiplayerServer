// How long chat, evidence and ban records are kept (Notice decisions 14-16).
// The rules that use them are in features/retention/limits.ts; the gateways'
// SQL reads them too.

export const DAY_MS = 24 * 60 * 60 * 1000

export const CHAT_KEEP_DAYS = 90
export const EVIDENCE_KEEP_DAYS = 180
export const CHAT_KEEP_MS = CHAT_KEEP_DAYS * DAY_MS
export const EVIDENCE_KEEP_MS = EVIDENCE_KEEP_DAYS * DAY_MS
export const BAN_RECORD_KEEP_MONTHS = 12
