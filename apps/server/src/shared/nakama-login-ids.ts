// How Nakama stores a Steam login (ADR 0004): the custom id, and the ban
// index key built from it. Must match nakama/src/player/steam_id.ts and
// nakama/src/moderation/enforce.ts (BAN_INDEX_CUSTOM_PREFIX).
//   steam:<raw Steam id>    before the rewrite (scripts/rewrite-steam-ids.ts)
//   steamhash:<hash>        after it

export const RAW_STEAM_CUSTOM_ID_PREFIX = 'steam:'
export const STEAM_HASH_CUSTOM_ID_PREFIX = 'steamhash:'
export const BAN_INDEX_CUSTOM_PREFIX = 'custom:'
