// The one-time move of Nakama accounts from "steam:<raw Steam id>" to
// "steamhash:<hash>" (ADR 0004), with their ban index entries. It runs
// against Nakama's database while Nakama is stopped
// (scripts/rewrite-steam-ids.ts); the deploy starts Nakama again only when
// it reports no raw-id login left. Running it again moves nothing.
//
// The prefixes must match nakama/src/player/steam_id.ts and the ban index
// keys of nakama/src/moderation/enforce.ts (loginKeys).
import type {
	INakamaAccountRepository,
	RawSteamLogins,
	SteamIdRewritePlan,
} from '../../contracts/INakamaAccountRepository.js'

const STEAM_HASH_CUSTOM_ID_PREFIX = 'steamhash:'
const RAW_STEAM_CUSTOM_ID_PREFIX = 'steam:'
const BAN_INDEX_CUSTOM_PREFIX = 'custom:'

export interface SteamIdRewriteResult {
	renamed: number
	banKeysMoved: number
	// Raw-id logins still there afterwards; anything but 0 is a failed run.
	left: number
}

export function planSteamIdRewrite(
	found: RawSteamLogins,
	hash: (steamId: string) => string,
): SteamIdRewritePlan {
	return {
		accounts: found.accounts.map(({ userId, steamId }) => ({
			userId,
			customId: STEAM_HASH_CUSTOM_ID_PREFIX + hash(steamId),
		})),
		banKeys: found.bannedSteamIds.map((steamId) => ({
			from: BAN_INDEX_CUSTOM_PREFIX + RAW_STEAM_CUSTOM_ID_PREFIX + steamId,
			to: BAN_INDEX_CUSTOM_PREFIX + STEAM_HASH_CUSTOM_ID_PREFIX + hash(steamId),
		})),
	}
}

export async function rewriteSteamIds(
	repo: INakamaAccountRepository,
	hash: (steamId: string) => string,
): Promise<SteamIdRewriteResult> {
	const plan = planSteamIdRewrite(await repo.findRawSteamLogins(), hash)
	if (plan.accounts.length > 0 || plan.banKeys.length > 0)
		await repo.applySteamIdRewrite(plan)
	return {
		renamed: plan.accounts.length,
		banKeysMoved: plan.banKeys.length,
		left: await repo.countRawSteamLogins(),
	}
}
