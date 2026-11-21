// A player's active bans, as the BMP API (Express) issues them. Postgres
// keeps the history; Nakama keeps what is in force now, in one object per
// player owned by that player but readable and writable only by the server.
export const MODERATION_COLLECTION = 'moderation'
export const BANS_KEY = 'bans'

export const BAN_TYPES = ['chat', 'queue', 'account', 'username'] as const
export type BanType = (typeof BAN_TYPES)[number]

export interface Ban {
	banId: string
	// Epoch ms, or null for a permanent ban or a timed ban whose clock has not
	// started yet (see isPending).
	expiresAt: number | null
	// The length of a timed ban. A timed chat, queue or account ban has no end
	// until the player is first told; startedAt then sets expiresAt to now plus
	// this. A permanent ban has none.
	durationMs?: number
	reason: string
}

export type Bans = { [T in BanType]?: Ban }

export function isBanType(value: unknown): value is BanType {
	return typeof value === 'string' && (BAN_TYPES as readonly string[]).indexOf(value) !== -1
}

export function isBan(value: unknown): value is Ban {
	const b = value as Ban
	return (
		typeof b === 'object' &&
		b !== null &&
		typeof b.banId === 'string' &&
		typeof b.reason === 'string' &&
		(b.expiresAt === null || (typeof b.expiresAt === 'number' && Number.isFinite(b.expiresAt))) &&
		(b.durationMs === undefined || (typeof b.durationMs === 'number' && Number.isFinite(b.durationMs)))
	)
}

// A timed ban whose clock has not started. It is enforced like a permanent one
// until it starts.
export function isPending(ban: Ban): boolean {
	return ban.expiresAt === null && typeof ban.durationMs === 'number'
}

// The ban with its clock started at `now`: it runs its full length from there.
export function startedAt(ban: Ban, now: number): Ban {
	return isPending(ban) ? { ...ban, expiresAt: now + (ban.durationMs as number) } : ban
}

// The ban of that type still in force at `now`, or null.
export function activeBan(bans: Bans, type: BanType, now: number): Ban | null {
	const ban = bans[type]
	if (!ban) return null
	return ban.expiresAt === null || ban.expiresAt > now ? ban : null
}

// When a ban would end if it counted from `now`; null for a permanent one.
function endOf(ban: Ban, now: number): number | null {
	return isPending(ban) ? now + (ban.durationMs as number) : ban.expiresAt
}

// The ban that lasts longer: a permanent one, else the later end. A repeat of
// the stored ban (same id) replaces it, except a repeat that has not started
// never undoes a start.
function longer(a: Ban | undefined, b: Ban, now: number): Ban {
	if (!a) return b
	if (a.banId === b.banId) return isPending(b) && a.expiresAt !== null ? a : b
	const endA = endOf(a, now)
	const endB = endOf(b, now)
	if (endA === null) return a
	if (endB === null) return b
	return endB > endA ? b : a
}

// Several bans of a type can be active at once in Postgres; Nakama keeps the
// one that lasts longest.
export function withBan(bans: Bans, type: BanType, ban: Ban, now: number = Date.now()): Bans {
	return { ...bans, [type]: longer(bans[type], ban, now) }
}

// bans with the given ban (by id) gone.
export function withoutBan(bans: Bans, banId: string): Bans {
	const next: Bans = {}
	for (const type of BAN_TYPES) {
		const ban = bans[type]
		if (ban && ban.banId !== banId) next[type] = ban
	}
	return next
}

// Drops every expired ban. Returns the same object when nothing expired.
export function withoutExpired(bans: Bans, now: number): Bans {
	let changed = false
	const next: Bans = {}
	for (const type of BAN_TYPES) {
		const ban = bans[type]
		if (!ban) continue
		if (activeBan(bans, type, now)) next[type] = ban
		else changed = true
	}
	return changed ? next : bans
}

export function bansFromList(
	list: { type: unknown; banId: unknown; expiresAt: unknown; durationMs?: unknown; reason: unknown }[],
): Bans {
	let bans: Bans = {}
	for (const entry of list) {
		const ban: { [key: string]: unknown } = { banId: entry.banId, expiresAt: entry.expiresAt, reason: entry.reason }
		if (typeof entry.durationMs === 'number') ban.durationMs = entry.durationMs
		if (isBanType(entry.type) && isBan(ban)) bans = withBan(bans, entry.type, ban)
	}
	return bans
}

export function readBans(nk: nkruntime.Nakama, userId: string): Bans {
	const objects = nk.storageRead([{ collection: MODERATION_COLLECTION, key: BANS_KEY, userId }])
	if (objects.length === 0) return {}
	const stored = objects[0].value as { [key: string]: unknown }
	const bans: Bans = {}
	for (const type of BAN_TYPES) if (isBan(stored[type])) bans[type] = stored[type] as Ban
	return bans
}

export function writeBans(nk: nkruntime.Nakama, userId: string, bans: Bans) {
	nk.storageWrite([
		{
			collection: MODERATION_COLLECTION,
			key: BANS_KEY,
			userId,
			value: bans as unknown as { [key: string]: unknown },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}
