import { type SQL, sql } from 'drizzle-orm'
import { DELETED_PLAYER_NAME } from '../../shared/deleted-player.js'
import { db } from '../db/index.js'

// Account deletion (Notice decision 17): the player id is replaced by a
// random anonymous id in every column that holds it, in one transaction.
// The other players' games, reports and ratings stay whole; nothing left
// links back to the account. Nakama does the same to its storage first
// (nakama/src/player/anonymize.ts), with the same anonymous id.
//
// Every column of the schema is listed below, either as a place a player id
// can be or as one that holds none; tests/gateways/player-anonymization.test.ts
// fails on a column in neither list, so a new table cannot be forgotten.

// id: the column holds exactly a player id.
// text / json: a player id can be inside the value ('admin:<id>',
//   '<runId>:<id>', a JSON document); every occurrence is replaced. Player
//   ids are UUIDs, so a plain text replace cannot hit anything else.
// delete: the rows only served the deleted player and go.
export type PlayerIdColumnKind = 'id' | 'text' | 'json' | 'delete'

export interface PlayerIdColumn {
	table: string
	column: string
	kind: PlayerIdColumnKind
}

export const PLAYER_ID_COLUMNS: readonly PlayerIdColumn[] = [
	{ table: 'refresh_tokens', column: 'player_id', kind: 'delete' },
	{ table: 'player_mutes', column: 'muter_id', kind: 'delete' },
	{ table: 'player_mutes', column: 'muted_id', kind: 'id' },
	{ table: 'game_results', column: 'players', kind: 'json' },
	{ table: 'game_results', column: 'result', kind: 'json' },
	{ table: 'chat_logs', column: 'player_id', kind: 'id' },
	{ table: 'action_logs', column: 'player_id', kind: 'id' },
	{ table: 'action_logs', column: 'payload', kind: 'json' },
	{ table: 'flagged_messages', column: 'player_id', kind: 'id' },
	{ table: 'reports', column: 'reporter_id', kind: 'id' },
	{ table: 'reports', column: 'reported_id', kind: 'id' },
	{ table: 'reported_lobby_messages', column: 'player_id', kind: 'id' },
	{ table: 'matchmaking_matches', column: 'players', kind: 'json' },
	{ table: 'matchmaking_matches', column: 'lobby_state', kind: 'json' },
	{ table: 'matchmaking_matches', column: 'result_placements', kind: 'json' },
	{ table: 'matchmaking_matches', column: 'result_reported_by', kind: 'text' },
	{ table: 'match_result_conflicts', column: 'first_reporter_id', kind: 'id' },
	{ table: 'match_result_conflicts', column: 'first_placements', kind: 'json' },
	{
		table: 'match_result_conflicts',
		column: 'conflicting_reporter_id',
		kind: 'id',
	},
	{
		table: 'match_result_conflicts',
		column: 'conflicting_placements',
		kind: 'json',
	},
	{ table: 'forfeit_reconciliation_flags', column: 'player_id', kind: 'id' },
	{ table: 'service_queue_items', column: 'source_id', kind: 'text' },
	{ table: 'service_queue_items', column: 'subject_player_id', kind: 'id' },
	{ table: 'service_queue_items', column: 'summary', kind: 'text' },
	{ table: 'service_queue_items', column: 'resolved_by', kind: 'text' },
	{ table: 'service_queue_items', column: 'claimed_by', kind: 'text' },
	{ table: 'service_queue_items', column: 'context', kind: 'json' },
	{ table: 'service_queue_item_events', column: 'actor', kind: 'text' },
	{ table: 'service_queue_item_events', column: 'detail', kind: 'json' },
	{ table: 'player_warnings', column: 'player_id', kind: 'id' },
	{ table: 'player_warnings', column: 'issued_by', kind: 'text' },
	{ table: 'grace_periods', column: 'player_id', kind: 'id' },
	{ table: 'matchmaking_ratings', column: 'player_id', kind: 'id' },
	{ table: 'leaderboard_cache', column: 'player_id', kind: 'id' },
	{ table: 'blog_post', column: 'author_player_id', kind: 'id' },
	{ table: 'player_bans', column: 'player_id', kind: 'id' },
	{ table: 'player_bans', column: 'issued_by', kind: 'text' },
	{ table: 'player_bans', column: 'lifted_by', kind: 'text' },
	{ table: 'match_run_logs', column: 'player_id', kind: 'id' },
	{ table: 'mod_profiles', column: 'created_by', kind: 'id' },
	{ table: 'launcher_integrity_events', column: 'player_id', kind: 'id' },
]

// Columns that never hold a player id, by table. The players row itself is
// replaced whole (see anonymizationStatements). Free text written by
// moderators (notes, messages) is not searched.
const NO_PLAYER_ID: { readonly [table: string]: readonly string[] } = {
	players: [
		'id',
		'steam_id_hash',
		'discord_id_hash',
		'discord_username',
		'use_discord_name',
		'preferred_joker',
		'privileges',
		'steam_name',
		'chat_enabled',
		'chat_blocked',
		'tos_accepted_version',
		'notice_accepted_at',
		'created_at',
		'updated_at',
		'deleted_at',
		'nakama_user_id',
	],
	refresh_tokens: ['id', 'token_hash', 'expires_at', 'created_at'],
	game_results: ['id', 'lobby_code', 'mod_id', 'started_at', 'ended_at'],
	chat_logs: [
		'id',
		'lobby_code',
		'moderation_id',
		'message',
		'flagged',
		'expires_at',
		'moderation_verdict',
		'sent_at',
		'mirror_key',
		'lobby_id',
	],
	action_logs: ['id', 'lobby_code', 'action_type', 'created_at'],
	server_config: [
		'id',
		'tos_version',
		'chat_enabled',
		'ranked_enabled',
		'casual_queue_enabled',
		'group_queue_enabled',
		'lobby_creation_enabled',
		'achievements_enabled',
		'updated_at',
	],
	mod_versions: [
		'mod_id',
		'display_name',
		'version',
		'download_url',
		'updated_at',
	],
	flagged_messages: [
		'id',
		'message',
		'matches',
		'flagged_at',
		'expires_at',
		'mirror_key',
	],
	reports: [
		'id',
		'lobby_id',
		'lobby_code',
		'type',
		'run_id',
		'status',
		'message',
		'additional_detail',
		'created_at',
	],
	reported_lobby_messages: [
		'id',
		'lobby_id',
		'lobby_code',
		'display_name',
		'message',
		'sent_at',
		'expires_at',
	],
	chat_allowlist: ['message'],
	matchmaking_matches: [
		'match_id',
		'lobby_code',
		'mod_id',
		'game_mode',
		'status',
		'game_started_at',
		'result_reported_at',
		'created_at',
		'updated_at',
	],
	match_result_conflicts: [
		'id',
		'match_id',
		'lobby_code',
		'status',
		'resolution_notes',
		'created_at',
	],
	forfeit_reconciliation_flags: [
		'id',
		'match_id',
		'lobby_code',
		'forfeited_at',
		'reconnected_at',
		'status',
		'resolution_notes',
		'created_at',
	],
	service_queue_items: [
		'id',
		'item_type',
		'status',
		'priority',
		'created_at',
		'resolved_at',
		'resolution_action',
		'resolution_notes',
		'claimed_until',
		'updated_at',
	],
	service_queue_item_events: ['id', 'item_id', 'kind', 'action', 'note', 'at'],
	player_warnings: ['id', 'item_id', 'message', 'issued_at'],
	grace_periods: [
		'id',
		'lobby_code',
		'display_name',
		'disconnected_at',
		'expires_at',
		'created_at',
	],
	matchmaking_ratings: [
		'mod_id',
		'game_mode',
		'season',
		'rating',
		'wins',
		'losses',
		'games_played',
		'season_best',
		'best_match_id',
		'best_at',
		'last_match_at',
		'decay_applied_at',
		'updated_at',
	],
	leaderboard_cache: [
		'mod_id',
		'game_mode',
		'season',
		'rank',
		'display_name',
		'rating',
		'wins',
		'losses',
		'games_played',
		'season_best',
		'updated_at',
	],
	seasons: ['id', 'name', 'started_at', 'ends_at', 'ended_at'],
	launcher_release: [
		'id',
		'version',
		'github_release_tag',
		'notes',
		'created_at',
		'updated_at',
	],
	launcher_release_asset: [
		'id',
		'release_id',
		'platform',
		'github_asset_id',
		'original_filename',
		'file_size',
		'sha256',
		'created_at',
	],
	blog_post: [
		'id',
		'kind',
		'title',
		'body_html',
		'status',
		'published_at',
		'created_at',
		'updated_at',
	],
	player_bans: [
		'id',
		'ban_type',
		'expires_at',
		'issued_at',
		'reason',
		'lifted_at',
	],
	player_mutes: ['id', 'created_at'],
	lobby_runs: [
		'id',
		'lobby_code',
		'mod_id',
		'lobby_type',
		'matchmaking_match_id',
		'status',
		'started_at',
		'finalized_at',
	],
	match_run_logs: [
		'run_id',
		'compressed_events',
		'carbon_hash',
		'event_count',
		'status',
		'flag_reason',
		'finalized_at',
		'expires_at',
	],
	mod_registry: [
		'id',
		'thunderstore_full_name',
		'title',
		'author',
		'categories',
		'is_custom',
		'automatic_version_check',
		'fixed_release_tag_updates',
		'search_terms',
		'requires_steamodded',
		'requires_talisman',
		'repo_url',
		'thumbnail_url',
		'description',
		'package_url',
		'donation_link',
		'latest_version',
		'latest_download_url',
		'ranked_version',
		'ranked_version_sha256',
		'smods_ids',
		'smods_ids_read_version',
		'ranked_download_url',
		'ranked_source',
		'ranked_download_status',
		'ranked_checked_at',
		'track_github',
		'featured',
		'hidden',
		'source_updated_at',
		'created_at',
		'updated_at',
	],
	mod_registry_versions: [
		'id',
		'mod_id',
		'version',
		'download_url',
		'released_at',
		'source',
		'aliases',
		'ref',
		'dependencies',
	],
	mod_profiles: [
		'id',
		'name',
		'slug',
		'description',
		'created_at',
		'updated_at',
	],
	mod_profile_entries: [
		'id',
		'profile_id',
		'mod_id',
		'version_mode',
		'pinned_version',
		'allowed',
	],
	launcher_integrity_events: ['id', 'kind', 'reason', 'occurred_at'],
}

export const NO_PLAYER_ID_COLUMNS: readonly string[] = Object.entries(
	NO_PLAYER_ID,
).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`))

const id = (name: string) => sql.identifier(name)

function columnStatement(
	c: PlayerIdColumn,
	playerId: string,
	anonymousId: string,
): SQL {
	const table = id(c.table)
	const column = id(c.column)
	if (c.kind === 'delete')
		return sql`delete from ${table} where ${column} = ${playerId}`
	if (c.kind === 'id')
		return sql`update ${table} set ${column} = ${anonymousId} where ${column} = ${playerId}`
	if (c.kind === 'text')
		return sql`update ${table} set ${column} = replace(${column}, ${playerId}, ${anonymousId}) where strpos(${column}, ${playerId}) > 0`
	return sql`update ${table} set ${column} = replace(${column}::text, ${playerId}, ${anonymousId})::jsonb where strpos(${column}::text, ${playerId}) > 0`
}

// Every statement of one deletion, in order. keptSteamIdHash is the peppered
// Steam ID hash the anonymous row keeps for ban enforcement, or null. Pure.
export function anonymizationStatements(
	playerId: string,
	anonymousId: string,
	keptSteamIdHash: string | null,
): SQL[] {
	const statements: SQL[] = [
		// Frees the unique hash and Nakama id for the new row.
		sql`update "players" set "steam_id_hash" = null, "discord_id_hash" = null, "nakama_user_id" = null where "id" = ${playerId}`,
		// nakama_user_id is the anonymous id too: Nakama renamed the player to
		// it, so a mirror entry still on its way lands on this row.
		sql`insert into "players" ("id", "steam_name", "steam_id_hash", "nakama_user_id", "deleted_at") values (${anonymousId}, ${DELETED_PLAYER_NAME}, ${keptSteamIdHash}, ${anonymousId}, now())`,
	]
	for (const c of PLAYER_ID_COLUMNS)
		statements.push(columnStatement(c, playerId, anonymousId))
	for (const table of [
		'reported_lobby_messages',
		'grace_periods',
		'leaderboard_cache',
	])
		statements.push(
			sql`update ${id(table)} set "display_name" = ${DELETED_PLAYER_NAME} where "player_id" = ${anonymousId}`,
		)
	statements.push(
		sql`update "matchmaking_matches" set "lobby_state" = jsonb_set("lobby_state", array['playerInfos', ${anonymousId}, 'displayName'], to_jsonb(${DELETED_PLAYER_NAME}::text)) where "lobby_state" -> 'playerInfos' -> ${anonymousId} is not null`,
	)
	if (keptSteamIdHash === null)
		statements.push(
			sql`update "chat_logs" set "moderation_id" = null where "player_id" = ${anonymousId}`,
		)
	statements.push(sql`delete from "players" where "id" = ${playerId}`)
	return statements
}

// Replaces playerId by anonymousId everywhere in Postgres. The peppered Steam
// ID hash stays on the anonymous row only when the player has a ban record
// (it enforces the ban on a new account; purgeExpiredDeletedPlayerHashes
// clears it later). A player id with no row still has its other rows moved.
export async function anonymizePlayer(
	playerId: string,
	anonymousId: string,
): Promise<void> {
	await db.transaction(async (tx) => {
		const found = await tx.execute(
			sql`select "steam_id_hash", exists (select 1 from "player_bans" where "player_id" = ${playerId}) as "banned" from "players" where "id" = ${playerId} for update`,
		)
		const row = found.rows[0] as
			| { steam_id_hash: string | null; banned: boolean }
			| undefined
		const kept = row?.banned ? row.steam_id_hash : null
		for (const statement of anonymizationStatements(
			playerId,
			anonymousId,
			kept,
		))
			await tx.execute(statement)
	})
}
