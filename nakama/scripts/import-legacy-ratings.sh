#!/bin/sh
# Copies the legacy Express server's ratings into a Nakama server's
# legacy_ratings collection (see src/rating/legacy.ts). Read-only on the
# source database; players claim their ratings at their next login.
#
#   LEGACY_SSH=<legacy-host> NAKAMA_URL=http://127.0.0.1:7350 NAKAMA_HTTP_KEY=... \
#     scripts/import-legacy-ratings.sh
#
# Safe to re-run: unclaimed players are overwritten, claimed ones are kept.
set -eu
: "${NAKAMA_HTTP_KEY:?set NAKAMA_HTTP_KEY (runtime.http_key)}"
NAKAMA_URL=${NAKAMA_URL:-http://127.0.0.1:7350}
: "${LEGACY_SSH:?set LEGACY_SSH (ssh host of the legacy server database)}"
export NAKAMA_URL NAKAMA_HTTP_KEY

QUERY="select coalesce(json_object_agg(h, boards), '{}'::json) from (
  select p.steam_id_hash as h, json_agg(json_build_object(
    'modId', r.mod_id, 'mode', r.game_mode, 'season', r.season, 'rating', r.rating,
    'wins', r.wins, 'losses', r.losses, 'gamesPlayed', r.games_played,
    'seasonBest', r.season_best,
    'lastMatchAt', coalesce(extract(epoch from r.last_match_at) * 1000, 0)::bigint)) as boards
  from matchmaking_ratings r join players p on p.id = r.player_id
  where p.steam_id_hash is not null group by p.steam_id_hash) t"

ssh "$LEGACY_SSH" "docker exec -i bmp-postgres psql -U postgres -d bmp -At" <<EOF |
$QUERY;
EOF
node --input-type=module -e '
const players = JSON.parse(await new Response(process.stdin).text())
const hashes = Object.keys(players)
let imported = 0, claimed = 0, skipped = 0
for (let i = 0; i < hashes.length; i += 100) {
	const batch = Object.fromEntries(hashes.slice(i, i + 100).map((h) => [h, { boards: players[h] }]))
	const res = await fetch(`${process.env.NAKAMA_URL}/v2/rpc/legacy_ratings_import?http_key=${process.env.NAKAMA_HTTP_KEY}&unwrap`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ players: batch }),
	})
	if (!res.ok) throw new Error(`import failed: ${res.status} ${await res.text()}`)
	const r = await res.json()
	imported += r.imported; claimed += r.alreadyClaimed; skipped += r.skipped
}
console.log(`players: ${hashes.length}, imported: ${imported}, already claimed: ${claimed}, skipped: ${skipped}`)
'
