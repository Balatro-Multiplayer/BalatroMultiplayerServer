// Removes what the *.live.mjs scripts leave behind, scoped to the test prefix
// (h1test_ by default) and the test mod id: Nakama accounts (admin_account_delete,
// which takes their storage and leaderboard records), system-owned run records
// of the test mod, and the Postgres rows the mirror, reports and webadmin made.
// Leaves the test mod's (empty) leaderboards: Nakama has no runtime call to
// delete one. Run: node nakama/scripts/live/cleanup.live.mjs
import { PREFIX, admin, psql, q } from './lib.mjs'

const MOD = PREFIX + 'mod'
const like = q(PREFIX.replace(/_/g, '\\_') + '%')

async function main() {
	const users = psql('nakama', `select id from users where username like ${like}`).map((r) => r[0])
	const pg = psql('bmp', `select id from players where steam_name like ${like}`).map((r) => r[0])
	const ids = [...new Set([...users, ...pg])]
	const idList = ids.length ? ids.map(q).join(',') : "''"

	// Postgres first (needs the Nakama ids to find report rows).
	const runs = `select id from lobby_runs where mod_id = ${q(MOD)}`
	const matches = `select match_id from matchmaking_matches where mod_id = ${q(MOD)}`
	// A private lobby's conflict has no matchmaking match: its match_id is the run id.
	const conflictMatches = `${matches} union select id::text from lobby_runs where mod_id = ${q(MOD)}`
	const conflicts = `select id::text from match_result_conflicts where match_id in (${conflictMatches})`
	const reports = `select id::text from reports where reporter_id::text in (${idList}) or reported_id::text in (${idList})`
	const sql = [
		`delete from service_queue_items where (item_type = 'anti_cheat' and split_part(source_id, ':', 1) in (${runs.replace('select id', 'select id::text')}))
		   or (item_type = 'match_conflict' and source_id in (${conflicts}))
		   or (item_type = 'report' and source_id in (${reports}))
		   or subject_player_id::text in (${idList})`,
		`delete from reported_lobby_messages where player_id in (${idList})`,
		`delete from reports where id::text in (${reports})`,
		`delete from match_result_conflicts where match_id in (${conflictMatches})`,
		`delete from forfeit_reconciliation_flags where player_id::text in (${idList})`,
		`delete from match_run_logs where run_id in (${runs})`,
		`delete from lobby_runs where mod_id = ${q(MOD)}`,
		`delete from matchmaking_matches where mod_id = ${q(MOD)}`,
		`delete from matchmaking_ratings where player_id::text in (${idList})`,
		`delete from player_warnings where player_id::text in (${idList})`,
		`delete from player_bans where player_id::text in (${idList})`,
		`delete from launcher_integrity_events where player_id::text in (${idList})`,
		`delete from chat_logs where player_id in (${idList})`,
		`delete from players where steam_name like ${like}`,
	]
	for (const s of sql) {
		try {
			psql('bmp', s)
		} catch (e) {
			console.log('FAILED:', s.slice(0, 90), String(e.stderr || e).slice(0, 200))
		}
	}

	let deleted = 0
	for (const id of users) {
		const r = await admin('admin_account_delete', { userId: id })
		if (r.ok) deleted++
		else console.log('account delete failed', id, r.text.slice(0, 120))
	}
	psql(
		'nakama',
		`delete from storage where user_id = '00000000-0000-0000-0000-000000000000'
		   and collection in ('match_runs', 'lobby_codes') and value->>'modId' = ${q(MOD)}`,
	)

	const left = {
		nakamaUsers: psql('nakama', `select count(*) from users where username like ${like}`)[0][0],
		systemRuns: psql('nakama', `select count(*) from storage where collection = 'match_runs' and value->>'modId' = ${q(MOD)}`)[0][0],
		leaderboards: psql('nakama', `select string_agg(id, ',') from leaderboard where id like ${like}`)[0]?.[0] || '',
		pgPlayers: psql('bmp', `select count(*) from players where steam_name like ${like}`)[0][0],
		lobbyRuns: psql('bmp', `select count(*) from lobby_runs where mod_id = ${q(MOD)}`)[0][0],
		matches: psql('bmp', `select count(*) from matchmaking_matches where mod_id = ${q(MOD)}`)[0][0],
	}
	console.log(`deleted ${deleted}/${users.length} Nakama accounts, ${pg.length} players rows`)
	console.log('LEFT ' + JSON.stringify(left))
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 2
})
