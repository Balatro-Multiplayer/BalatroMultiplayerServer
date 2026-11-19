#!/usr/bin/env bash
# Fast tests for scripts/deploy/wait-for-ranked.sh. Time is virtual: a fake
# clock file, a fake sleep that advances it, and a fake curl that answers from
# a queue (a number = that many live Ranked matches, "fail" = network error).
# The public queue counts have their own queue (a number = that many players in
# Ranked lobbies, split over two mods; "fail"; "html" = not JSON); with no
# queue they fail.
# Run: scripts/deploy/test/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../wait-for-ranked.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else bad "$1 (missing '$2' in: $3)"; fi; }
assert_not_contains() { if grep -qF -- "$2" <<<"$3"; then bad "$1 (unexpected '$2' in: $3)"; else ok "$1"; fi; }

cat >"$WORK/now" <<'F'
#!/usr/bin/env bash
cat "$FAKE_CLOCK"
F
cat >"$WORK/sleep" <<'F'
#!/usr/bin/env bash
echo "$1" >>"$FAKE_SLEEPS"
echo $(($(cat "$FAKE_CLOCK") + $1)) >"$FAKE_CLOCK"
F
# Each call pops the first line of its queue; the last line repeats.
cat >"$WORK/curl" <<'F'
#!/usr/bin/env bash
pop() {
	head -n1 "$1"
	[ "$(wc -l <"$1")" -gt 1 ] && sed -i 1d "$1"
}
case "$*" in
*/api/stats/queues*)
	cat >"$FAKE_STDIN_STATS"
	echo "$*" >"$FAKE_CURL_ARGS_STATS"
	echo polled >>"$FAKE_POLLS_STATS"
	[ -s "$FAKE_QUEUE_STATS" ] || exit 22
	answer=$(pop "$FAKE_QUEUE_STATS")
	case "$answer" in
	fail) exit 22 ;;
	html) echo "<html>Bad gateway</html>" ;;
	*)
		a=$((answer / 2)); b=$((answer - a))
		echo "{\"MultiplayerPvP\":{\"pvp_nemesis\":{\"queued\":1,\"inMatch\":6},\"ranked:pvp_ranked_expanded\":{\"queued\":2,\"inMatch\":$a},\"ranked:pvp_ranked_balanced\":{\"queued\":0,\"inMatch\":0}},\"MultiplayerSPDRN\":{\"ranked:spdrn_gold_stake_single\":{\"queued\":3,\"inMatch\":$b}}}"
		;;
	esac
	;;
*)
	cat >"$FAKE_STDIN"   # the header file arrives on stdin
	echo "$*" >"$FAKE_CURL_ARGS"
	answer=$(pop "$FAKE_QUEUE")
	echo polled >>"$FAKE_POLLS"
	if [ "$answer" = fail ]; then exit 22; fi
	echo "{\"running\":$answer}"
	;;
esac
F
chmod +x "$WORK/now" "$WORK/sleep" "$WORK/curl"

# run_case <queue lines...>: runs the script with a virtual clock at 1000 and
# the close at 1000. STATS="<lines>" fills the queue counts queue. Sets OUT
# (stdout+stderr), CODE, RESULT, SLEEPS, POLLS, STATS_POLLS.
run_case() {
	rm -f "$WORK/sleeps" "$WORK/polls" "$WORK/polls_stats" "$WORK/result" "$WORK/stdin_stats" "$WORK/args_stats"
	printf '%s\n' "$@" >"$WORK/queue"
	if [ -n "${STATS:-}" ]; then tr ' ' '\n' <<<"$STATS" >"$WORK/queue_stats"; else : >"$WORK/queue_stats"; fi
	echo "${CLOCK_START:-1000}" >"$WORK/clock"
	OUT=$(
		FAKE_CLOCK="$WORK/clock" FAKE_SLEEPS="$WORK/sleeps" FAKE_POLLS="$WORK/polls" \
			FAKE_QUEUE="$WORK/queue" FAKE_STDIN="$WORK/stdin" FAKE_CURL_ARGS="$WORK/args" \
			FAKE_QUEUE_STATS="$WORK/queue_stats" FAKE_STDIN_STATS="$WORK/stdin_stats" \
			FAKE_CURL_ARGS_STATS="$WORK/args_stats" FAKE_POLLS_STATS="$WORK/polls_stats" \
			BMP_API_URL="https://api.test/" BMP_DEPLOY_TOKEN="s3cret-token" \
			CLOSE_EPOCH=1000 CURL_CMD="$WORK/curl" SLEEP_CMD="$WORK/sleep" NOW_CMD="$WORK/now" \
			MIN_WAIT_SECONDS=1800 MAX_WAIT_SECONDS=4800 POLL_SECONDS=60 \
			RESULT_FILE="$WORK/result" "$SCRIPT" 2>&1
	)
	CODE=$?
	RESULT=$(cat "$WORK/result" 2>/dev/null || true)
	SLEEPS=$(cat "$WORK/sleeps" 2>/dev/null || true)
	POLLS=0; [ -f "$WORK/polls" ] && POLLS=$(wc -l <"$WORK/polls" | tr -d " ")
	STATS_POLLS=0; [ -f "$WORK/polls_stats" ] && STATS_POLLS=$(wc -l <"$WORK/polls_stats" | tr -d " ")
}

# 1. Zero live matches still waits the full minimum, then deploys at once.
run_case 0
assert_eq "zero live: exit 0" 0 "$CODE"
assert_eq "zero live: waits 1800 first" 1800 "$(head -n1 <<<"$SLEEPS")"
assert_eq "zero live: one poll only" 1 "$POLLS"
assert_contains "zero live: not forced" "forced=false" "$RESULT"
assert_contains "zero live: waited 1800" "waited_seconds=1800" "$RESULT"
assert_contains "zero live: count printed" "running=0" "$OUT"

# 2. Matches end after a few polls: polls every 60 s until 0.
run_case 3 2 1 0
assert_eq "drain: exit 0" 0 "$CODE"
assert_eq "drain: four polls" 4 "$POLLS"
assert_eq "drain: 60 s between polls" "60 60 60" "$(tail -n +2 <<<"$SLEEPS" | tr '\n' ' ' | sed 's/ $//')"
assert_contains "drain: waited 1980" "waited_seconds=1980" "$RESULT"
assert_contains "drain: not forced" "forced=false" "$RESULT"
assert_contains "drain: prints count" "running=2" "$OUT"

# 3. Matches never end: forced at 80 minutes with the count recorded.
run_case 5
assert_eq "force: exit 0" 0 "$CODE"
assert_contains "force: forced" "forced=true" "$RESULT"
assert_contains "force: waited 4800" "waited_seconds=4800" "$RESULT"
assert_contains "force: count at limit" "running_at_end=5" "$RESULT"
assert_contains "force: says so" "force limit" "$OUT"

# 4. Failed polls are warnings, not failures; polling goes on.
run_case fail fail 0
assert_eq "poll failure: exit 0" 0 "$CODE"
assert_contains "poll failure: warning" "::warning::" "$OUT"
assert_contains "poll failure: then deploys" "forced=false" "$RESULT"
assert_eq "poll failure: three polls" 3 "$POLLS"

# 5. All polls fail to the limit: forced, count unknown.
run_case fail
assert_eq "all fail: exit 0" 0 "$CODE"
assert_contains "all fail: forced" "forced=true" "$RESULT"
assert_contains "all fail: unknown count" "running_at_end=unknown" "$RESULT"

# 6. The clock counts from the close, not from the script start.
CLOCK_START=1600 run_case 0
assert_eq "late start: waits only the rest" 1200 "$(head -n1 <<<"$SLEEPS")"
assert_contains "late start: waited 1800 from close" "waited_seconds=1800" "$RESULT"

# 7. The token never shows in output or arguments, and goes by stdin.
assert_not_contains "token not in output" "s3cret-token" "$OUT"
assert_not_contains "token not in curl args" "s3cret-token" "$(cat "$WORK/args")"
assert_contains "token in stdin header" "Authorization: Bearer s3cret-token" "$(cat "$WORK/stdin")"
assert_contains "url: live route, no double slash" "https://api.test/api/deploy/ranked/live" "$(cat "$WORK/args")"

# 8. The live count works: the queue counts are never called, source is live.
run_case 2 0
assert_eq "live ok: no queue counts call" 0 "$STATS_POLLS"
assert_contains "live ok: source live" "count_source=live" "$RESULT"

# 9. The live count fails: the players in Ranked lobbies decide. Casual
# players (pvp_nemesis inMatch 6) do not count.
STATS="5 4 0" run_case fail
assert_eq "fallback: exit 0" 0 "$CODE"
assert_eq "fallback: three queue counts calls" 3 "$STATS_POLLS"
assert_contains "fallback: not forced" "forced=false" "$RESULT"
assert_contains "fallback: waited 1920" "waited_seconds=1920" "$RESULT"
assert_contains "fallback: source lobbies" "count_source=lobbies" "$RESULT"
assert_contains "fallback: prints players" "players in Ranked lobbies=5" "$OUT"
assert_eq "fallback: one warning only" 1 "$(grep -c '::warning::' <<<"$OUT")"
assert_contains "fallback: warning names the route" "/api/stats/queues" "$OUT"
assert_eq "fallback: no token sent to the public route" "" "$(cat "$WORK/stdin_stats")"
assert_not_contains "fallback: no token in its args" "s3cret-token" "$(cat "$WORK/args_stats")"
assert_contains "fallback: public url, no double slash" "https://api.test/api/stats/queues" "$(cat "$WORK/args_stats")"

# 10. Casual players only: 0 in Ranked lobbies deploys at once.
STATS="0" run_case fail
assert_eq "casual only: one queue counts call" 1 "$STATS_POLLS"
assert_contains "casual only: waited 1800" "waited_seconds=1800" "$RESULT"

# 11. Players never leave: forced at the limit with the player count.
STATS="7" run_case fail
assert_contains "fallback force: forced" "forced=true" "$RESULT"
assert_contains "fallback force: players at end" "running_at_end=7" "$RESULT"
assert_contains "fallback force: source lobbies" "count_source=lobbies" "$RESULT"

# 12. A bad answer from the queue counts is a failed call, not 0 players.
STATS="html html 0" run_case fail
assert_eq "bad answer: three queue counts calls" 3 "$STATS_POLLS"
assert_contains "bad answer: waited 1920" "waited_seconds=1920" "$RESULT"

# 13. Both calls fail to the limit: forced, count unknown, source none.
STATS="fail" run_case fail
assert_contains "both fail: forced" "forced=true" "$RESULT"
assert_contains "both fail: unknown count" "running_at_end=unknown" "$RESULT"
assert_contains "both fail: source none" "count_source=none" "$RESULT"

# 14. The live count comes back after a fallback: it is used again.
STATS="3" run_case fail 0
assert_contains "live back: source live" "count_source=live" "$RESULT"
assert_contains "live back: waited 1860" "waited_seconds=1860" "$RESULT"

# 15. Missing settings fail fast.
OUT=$(env -u BMP_DEPLOY_TOKEN BMP_API_URL=x CLOSE_EPOCH=1 "$SCRIPT" 2>&1)
assert_eq "missing token: exit 1" 1 "$?"
assert_contains "missing token: names it" "BMP_DEPLOY_TOKEN" "$OUT"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
