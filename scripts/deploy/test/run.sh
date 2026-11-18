#!/usr/bin/env bash
# Fast tests for scripts/deploy/wait-for-ranked.sh. Time is virtual: a fake
# clock file, a fake sleep that advances it, and a fake curl that answers from
# a queue (a number = that many live Ranked matches, "fail" = network error).
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
# Each call pops the first line of the queue; the last line repeats.
cat >"$WORK/curl" <<'F'
#!/usr/bin/env bash
cat >"$FAKE_STDIN"   # the header file arrives on stdin
echo "$*" >"$FAKE_CURL_ARGS"
answer=$(head -n1 "$FAKE_QUEUE")
[ "$(wc -l <"$FAKE_QUEUE")" -gt 1 ] && sed -i 1d "$FAKE_QUEUE"
echo polled >>"$FAKE_POLLS"
if [ "$answer" = fail ]; then exit 22; fi
echo "{\"running\":$answer}"
F
chmod +x "$WORK/now" "$WORK/sleep" "$WORK/curl"

# run_case <queue lines...>: runs the script with a virtual clock at 1000 and
# the close at 1000. Sets OUT (stdout+stderr), CODE, RESULT, SLEEPS, POLLS.
run_case() {
	rm -f "$WORK/sleeps" "$WORK/polls" "$WORK/result"
	printf '%s\n' "$@" >"$WORK/queue"
	echo "${CLOCK_START:-1000}" >"$WORK/clock"
	OUT=$(
		FAKE_CLOCK="$WORK/clock" FAKE_SLEEPS="$WORK/sleeps" FAKE_POLLS="$WORK/polls" \
			FAKE_QUEUE="$WORK/queue" FAKE_STDIN="$WORK/stdin" FAKE_CURL_ARGS="$WORK/args" \
			BMP_API_URL="https://api.test/" BMP_DEPLOY_TOKEN="s3cret-token" \
			CLOSE_EPOCH=1000 CURL_CMD="$WORK/curl" SLEEP_CMD="$WORK/sleep" NOW_CMD="$WORK/now" \
			MIN_WAIT_SECONDS=1800 MAX_WAIT_SECONDS=4800 POLL_SECONDS=60 \
			RESULT_FILE="$WORK/result" "$SCRIPT" 2>&1
	)
	CODE=$?
	RESULT=$(cat "$WORK/result" 2>/dev/null || true)
	SLEEPS=$(cat "$WORK/sleeps" 2>/dev/null || true)
	POLLS=0; [ -f "$WORK/polls" ] && POLLS=$(wc -l <"$WORK/polls" | tr -d " ")
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

# 8. Missing settings fail fast.
OUT=$(env -u BMP_DEPLOY_TOKEN BMP_API_URL=x CLOSE_EPOCH=1 "$SCRIPT" 2>&1)
assert_eq "missing token: exit 1" 1 "$?"
assert_contains "missing token: names it" "BMP_DEPLOY_TOKEN" "$OUT"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
