#!/usr/bin/env bash
# Deploy steps for the Official server host, run from the folder that holds
# the new copy of the code. bmp-deploy (scripts/host/bmp-deploy) copies the
# commit over the server folder, then calls this script.
#
#   scripts/host-deploy.sh full   Nakama, then the API, then the website
#   scripts/host-deploy.sh web    the API and the website only
#
# Both modes end by rebuilding and starting the Discord rank-role bot
# (apps/discord-bot), so it runs wherever the server runs.
#
# Order matters: Nakama first, so an API that calls a new Nakama RPC finds it.
# Nakama's prod.yml is a single-file bind mount, so it needs a force-recreate
# (not a restart) to see a new file. The website must be followed by an nginx
# reload, because nginx resolves web:3000 only at start: a web restart alone
# leaves the whole site at 502.
#
# Any failed step stops the script with a non-zero exit, except the bot step:
# the bot is an extra, so a failure there only logs a warning.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-}"
OVERLAY="${COMPOSE_OVERLAY-docker-compose.balatro.yml}"
HEALTH_TIMEOUT_S="${BMP_HEALTH_TIMEOUT_S:-120}"
POLL_S="${BMP_POLL_S:-2}"
COLOR_SWAP="${BMP_COLOR_SWAP:-./scripts/deploy-color-swap.sh}"

log() { echo "[host-deploy] $*"; }
die() {
	echo "[host-deploy] ERROR: $*" >&2
	exit 1
}

case "$MODE" in
full | web) ;;
*)
	echo "[host-deploy] usage: host-deploy.sh <full|web>" >&2
	exit 2
	;;
esac

if [ -n "$OVERLAY" ]; then
	COMPOSE=(docker compose -f docker-compose.yml -f "$OVERLAY")
else
	COMPOSE=(docker compose -f docker-compose.yml)
fi

# wait_for <label> <command...>: retry the command until it succeeds.
wait_for() {
	local label="$1"
	shift
	local start=$SECONDS
	while ! "$@" >/dev/null 2>&1; do
		if [ $((SECONDS - start)) -ge "$HEALTH_TIMEOUT_S" ]; then
			die "$label did not answer within ${HEALTH_TIMEOUT_S}s"
		fi
		sleep "$POLL_S"
	done
	log "$label is up"
}

container_healthy() {
	[ "$(docker inspect --format='{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]
}

log "mode: $MODE"

if [ "$MODE" = full ]; then
	log "step 1: recreate Nakama"
	"${COMPOSE[@]}" up -d --no-deps --force-recreate nakama
	log "waiting for Nakama health"
	wait_for "Nakama" container_healthy bmp-nakama
fi

log "step: swap the API (blue/green, with migrations)"
COMPOSE_OVERLAY="$OVERLAY" "$COLOR_SWAP"

log "step: build the website"
"${COMPOSE[@]}" build web
log "step: start the website"
"${COMPOSE[@]}" up -d --no-deps web

log "step: reload nginx"
docker exec bmp-nginx nginx -s reload

log "step: check the site answers"
wait_for "website" docker exec bmp-nginx wget -q --spider http://web:3000/
wait_for "API" docker exec bmp-nginx wget -q --spider http://127.0.0.1:8788/health

# Last, so a bot problem never holds up the site. Without
# apps/discord-bot/.env the bot logs "disabled" once and idles.
log "step: build and start the Discord bot"
if ! { "${COMPOSE[@]}" build discord-bot && "${COMPOSE[@]}" up -d --no-deps discord-bot; }; then
	log "WARNING: the Discord bot did not build or start; the rest of the deploy is fine"
fi

log "done: $MODE deploy finished"
