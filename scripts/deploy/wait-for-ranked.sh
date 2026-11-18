#!/usr/bin/env bash
# The wait in the Full deploy: always at least MIN_WAIT_SECONDS after Ranked
# closed, then poll GET /api/deploy/ranked/live every POLL_SECONDS until no
# Ranked match is running, or until MAX_WAIT_SECONDS after the close. At the
# limit it gives up waiting and the caller deploys anyway.
#
# Needs BMP_API_URL, BMP_DEPLOY_TOKEN and CLOSE_EPOCH (unix seconds of the
# close). Writes waited_seconds, forced and running_at_end as key=value lines
# to RESULT_FILE (the job's $GITHUB_OUTPUT). A failed poll is a warning: the
# network may blip during a long wait. The token goes to curl on stdin, so it
# never shows in a process list or a log.
#
# The *_CMD and *_SECONDS settings exist so the tests can run in virtual time.
set -uo pipefail

: "${BMP_API_URL:?BMP_API_URL is not set}"
: "${BMP_DEPLOY_TOKEN:?BMP_DEPLOY_TOKEN is not set}"
: "${CLOSE_EPOCH:?CLOSE_EPOCH is not set}"
MIN_WAIT_SECONDS="${MIN_WAIT_SECONDS:-1800}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-4800}"
POLL_SECONDS="${POLL_SECONDS:-60}"
RESULT_FILE="${RESULT_FILE:-/dev/null}"
read -ra CURL <<<"${CURL_CMD:-curl}"
read -ra SLEEP <<<"${SLEEP_CMD:-sleep}"
read -ra NOW <<<"${NOW_CMD:-date +%s}"

elapsed() { echo $(($("${NOW[@]}") - CLOSE_EPOCH)); }

# Prints the live count, or nothing when the call or the answer is bad.
poll() {
	local body
	body=$(printf 'Authorization: Bearer %s' "$BMP_DEPLOY_TOKEN" |
		"${CURL[@]}" -sS -f --max-time 20 -H @- "${BMP_API_URL%/}/api/deploy/ranked/live") || return 1
	sed -n 's/.*"running"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' <<<"$body" | grep -m1 .
}

echo "Waiting at least $((MIN_WAIT_SECONDS / 60)) min from the close, then polling every ${POLL_SECONDS} s (limit $((MAX_WAIT_SECONDS / 60)) min)."
first=$((MIN_WAIT_SECONDS - $(elapsed)))
if [ "$first" -gt 0 ]; then "${SLEEP[@]}" "$first"; fi

forced=false
running=unknown
while true; do
	if count=$(poll); then
		running="$count"
		echo "[$(($(elapsed) / 60)) min] running=$count"
		[ "$count" = 0 ] && break
	else
		echo "::warning::The live Ranked count call failed; trying again."
		echo "[$(($(elapsed) / 60)) min] running=unknown"
	fi
	left=$((MAX_WAIT_SECONDS - $(elapsed)))
	if [ "$left" -le 0 ]; then
		forced=true
		echo "Reached the force limit ($((MAX_WAIT_SECONDS / 60)) min) with running=$running. Deploying anyway."
		break
	fi
	step=$POLL_SECONDS
	[ "$left" -lt "$step" ] && step=$left
	"${SLEEP[@]}" "$step"
done

{
	echo "waited_seconds=$(elapsed)"
	echo "forced=$forced"
	echo "running_at_end=$running"
} >>"$RESULT_FILE"
