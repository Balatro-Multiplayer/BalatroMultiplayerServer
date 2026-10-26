// The catch-up limit: how long a seat may stay "catching up" (ClientOp.CATCHING_UP)
// before the server forfeits it, the same way as a grace forfeit. It is a rule of
// the mod, not of the client: a table here, keyed by the lobby's mod id, so a
// matchmade lobby (no client creates it) and a tampered client both get it. A mod
// not in the table has no limit (SPDRN is a race: the other racer's clock runs on
// anyway).

// MultiplayerPvP: a blind cannot start without both players, so a stuck client
// must not hold the match forever.
export const CATCH_UP_LIMIT_MS_BY_MOD: { [modId: string]: number } = {
	MultiplayerPvP: 180_000,
}

// The reason in the player_kicked event a seat forfeited at the limit gets
// (`data.reason`). MPAPI api/lobby/events.lua reads it: keep both the same.
export const CATCH_UP_LIMIT_REASON = 'catch_up_limit'

// The limit a new lobby of `modId` gets, or null for none. `overrideSeconds`
// (the LOBBY_CATCH_UP_LIMIT_SECONDS env var, for tests) replaces the limit of a
// mod that has one; it never gives a limit to a mod that has none.
export function catchUpLimitMsFor(modId: string, overrideSeconds?: number): number | null {
	const limit = CATCH_UP_LIMIT_MS_BY_MOD[modId]
	if (limit === undefined) return null
	return overrideSeconds !== undefined && overrideSeconds > 0 ? overrideSeconds * 1000 : limit
}
