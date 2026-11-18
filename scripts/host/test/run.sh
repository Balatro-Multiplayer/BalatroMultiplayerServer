#!/usr/bin/env bash
# Fast local tests for scripts/host/bmp-deploy and scripts/host-deploy.sh.
# No network, no real docker: `docker` is a fake on PATH that records its
# calls, and the "GitHub tarball" is a file:// fixture.
# Run: scripts/host/test/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BMP_DEPLOY="$REPO/scripts/host/bmp-deploy"
HOST_DEPLOY="$REPO/scripts/host-deploy.sh"
SHA=0123456789abcdef0123456789abcdef01234567

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else bad "$1 (missing '$2' in: $3)"; fi; }
assert_not_contains() { if grep -qF -- "$2" <<<"$3"; then bad "$1 (unexpected '$2' in: $3)"; else ok "$1"; fi; }

# A fake docker: logs every call to $FAKE_DOCKER_LOG. Health inspects answer
# "healthy". FAKE_DOCKER_FAIL=<substring> makes a call containing it exit 1.
FAKEBIN="$WORK/bin"
mkdir -p "$FAKEBIN"
cat >"$FAKEBIN/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_DOCKER_LOG"
if [ -n "${FAKE_DOCKER_FAIL:-}" ] && [[ "$*" == *"$FAKE_DOCKER_FAIL"* ]]; then
	exit 1
fi
if [ "$1" = inspect ]; then
	echo healthy
fi
exit 0
FAKE
chmod +x "$FAKEBIN/docker"
export PATH="$FAKEBIN:$PATH"
export FAKE_DOCKER_LOG="$WORK/docker.log"

# --- bmp-deploy: argument validation ---------------------------------------

run_deploy() { # run_deploy "<SSH_ORIGINAL_COMMAND>"
	SSH_ORIGINAL_COMMAND="$1" BMP_DEPLOY_ROOT="$WORK/none" BMP_DEPLOY_LOCK="$WORK/lock" \
		"$BMP_DEPLOY" 2>&1
}

for cmd in "" "ls" "bash" "full" "web" "full abc" "full ${SHA}0" "full ${SHA%?}" \
	"full ${SHA^^}" "full ${SHA} extra" "full ${SHA}; ls" "status now" "STATUS" \
	"rollback ${SHA}" "full  ${SHA}" $'full '"${SHA}"$'\nls'; do
	out="$(run_deploy "$cmd")"
	code=$?
	assert_eq "refuses '${cmd//$'\n'/\\n}' with exit 2" 2 "$code"
done

# --- fixtures ---------------------------------------------------------------

# The "GitHub tarball": <base>/<sha> is a gzip tarball with one top folder.
make_tarball() { # make_tarball <dir-with-tree> <out-file>
	local top="$WORK/top/Org-Repo-$SHA"
	rm -rf "$WORK/top"
	mkdir -p "$WORK/top"
	cp -r "$1" "$top"
	tar -C "$WORK/top" -czf "$2" "Org-Repo-$SHA"
}

new_tree() { # a fresh checkout of the "new commit"
	local t="$WORK/newtree"
	rm -rf "$t"
	mkdir -p "$t/scripts" "$t/nakama/modules" "$t/nginx" "$t/apps/server" "$t/packages/internal/src"
	echo "version: new" >"$t/docker-compose.yml"
	echo "new bundle" >"$t/nakama/modules/index.js"
	echo "new prod" >"$t/nakama/prod.yml"
	echo "upstream api-green" >"$t/nginx/upstream.conf"
	echo "public stub" >"$t/packages/internal/src/index.ts"
	echo "new code" >"$t/apps/server/main.ts"
	echo "new compose local" >"$t/compose.local.yml"
	echo "NEW=example" >"$t/.env.example"
	echo "new local env" >"$t/.env.local"
	echo "new prod env" >"$t/.env.production"
	echo "new web local env" >"$t/apps/server/.env.web.local"
	echo "new override" >"$t/docker-compose.local.override.yml"
	cat >"$t/scripts/host-deploy.sh" <<'STUB'
#!/usr/bin/env bash
echo "host-deploy $*" >>"$HOST_DEPLOY_LOG"
[ -z "${STUB_FAIL:-}" ]
STUB
	chmod +x "$t/scripts/host-deploy.sh"
	echo "$t"
}

new_root() { # a fresh host folder holding the old copy plus state
	local r="$WORK/root"
	rm -rf "$r"
	mkdir -p "$r/nakama/modules" "$r/nginx" "$r/apps/server" "$r/packages/internal/src" "$r/data/pg" "$r/backups" "$r/logs"
	echo "SECRET=1" >"$r/.env"
	echo "API_SECRET=1" >"$r/apps/server/.env"
	echo "dbfile" >"$r/data/pg/base"
	echo "log" >"$r/logs/a.log"
	echo "upstream api-blue" >"$r/nginx/upstream.conf"
	echo "private strategy" >"$r/packages/internal/src/challenge-strategy.ts"
	echo "private index" >"$r/packages/internal/src/index.ts"
	echo "old bundle" >"$r/nakama/modules/index.js"
	echo "old prod" >"$r/nakama/prod.yml"
	echo "oldsha" >"$r/DEPLOYED_COMMIT"
	echo "old compose local" >"$r/compose.local.yml"
	echo "OLD=example" >"$r/.env.example"
	echo "host local env" >"$r/.env.local"
	echo "host prod env" >"$r/.env.production"
	echo "host web local env" >"$r/apps/server/.env.web.local"
	echo "host override" >"$r/docker-compose.local.override.yml"
	echo "$r"
}

setup_deploy() {
	NEWTREE="$(new_tree)"
	ROOT="$(new_root)"
	TARBALLS="$WORK/tarballs"
	mkdir -p "$TARBALLS"
	make_tarball "$NEWTREE" "$TARBALLS/$SHA"
	: >"$FAKE_DOCKER_LOG"
	export HOST_DEPLOY_LOG="$WORK/host-deploy.log"
	: >"$HOST_DEPLOY_LOG"
}

full_deploy() { # full_deploy <mode> [extra env assignments via env]
	SSH_ORIGINAL_COMMAND="$1 $SHA" BMP_DEPLOY_ROOT="$ROOT" BMP_DEPLOY_LOCK="$WORK/lock" \
		BMP_TARBALL_BASE="file://$TARBALLS" BMP_BACKUP_DIR="$WORK/backups" \
		"$BMP_DEPLOY" 2>&1
}

# --- bmp-deploy: sha check and copy ------------------------------------------

setup_deploy
mv "$TARBALLS/$SHA" "$TARBALLS/other"
out="$(full_deploy full)"
code=$?
assert_eq "missing tarball fails" 1 "$code"
assert_eq "missing tarball leaves DEPLOYED_COMMIT" oldsha "$(cat "$ROOT/DEPLOYED_COMMIT")"
assert_eq "missing tarball runs no host-deploy" "" "$(cat "$HOST_DEPLOY_LOG")"

setup_deploy
rm "$NEWTREE/scripts/host-deploy.sh"
make_tarball "$NEWTREE" "$TARBALLS/$SHA"
out="$(full_deploy full)"
assert_eq "tarball without host-deploy.sh is refused" 1 "$?"
assert_eq "refused tarball does not touch the folder" "old bundle" "$(cat "$ROOT/nakama/modules/index.js")"

setup_deploy
out="$(full_deploy full)"
code=$?
assert_eq "full deploy succeeds" 0 "$code"
assert_eq "full deploy runs host-deploy full" "host-deploy full" "$(cat "$HOST_DEPLOY_LOG")"
assert_eq "DEPLOYED_COMMIT written" "$SHA" "$(cat "$ROOT/DEPLOYED_COMMIT")"
assert_eq "tracked file updated" "new bundle" "$(cat "$ROOT/nakama/modules/index.js")"
assert_eq "new file added" "new code" "$(cat "$ROOT/apps/server/main.ts")"
assert_eq ".env untouched" "SECRET=1" "$(cat "$ROOT/.env")"
assert_eq "apps/server/.env untouched" "API_SECRET=1" "$(cat "$ROOT/apps/server/.env")"
assert_eq ".env.local untouched" "host local env" "$(cat "$ROOT/.env.local")"
assert_eq ".env.production untouched" "host prod env" "$(cat "$ROOT/.env.production")"
assert_eq ".env.*.local untouched" "host web local env" "$(cat "$ROOT/apps/server/.env.web.local")"
assert_eq "other *.local* file untouched" "host override" "$(cat "$ROOT/docker-compose.local.override.yml")"
assert_eq "compose.local.yml is copied" "new compose local" "$(cat "$ROOT/compose.local.yml")"
assert_eq ".env.example is copied" "NEW=example" "$(cat "$ROOT/.env.example")"
assert_eq "full deploy writes DEPLOYED_NAKAMA_COMMIT" "$SHA" "$(cat "$ROOT/DEPLOYED_NAKAMA_COMMIT")"
assert_eq "data untouched" "dbfile" "$(cat "$ROOT/data/pg/base")"
assert_eq "logs untouched" "log" "$(cat "$ROOT/logs/a.log")"
assert_eq "upstream.conf keeps the live color" "upstream api-blue" "$(cat "$ROOT/nginx/upstream.conf")"
assert_eq "private internal package kept" "private strategy" "$(cat "$ROOT/packages/internal/src/challenge-strategy.ts")"
assert_eq "private internal index kept" "private index" "$(cat "$ROOT/packages/internal/src/index.ts")"
assert_eq "one backup written" 1 "$(find "$WORK/backups" -name '*.tar.gz' | wc -l)"
backup="$(find "$WORK/backups" -name '*.tar.gz' | head -1)"
assert_eq "backup holds the old bundle" "old bundle" "$(tar -xzOf "$backup" nakama/modules/index.js)"
assert_eq "backup excludes secrets" "" "$(tar -tzf "$backup" | grep -E '(^|/)\.env(\.local|\.production|\..*\.local)?$')"
assert_contains "backup holds the old .env.example" ".env.example" "$(tar -tzf "$backup")"

# A failed host-deploy keeps DEPLOYED_COMMIT and fails.
setup_deploy
out="$(STUB_FAIL=1 full_deploy web)"
code=$?
assert_eq "failing host-deploy fails bmp-deploy" 1 "$code"
assert_eq "failing host-deploy keeps DEPLOYED_COMMIT" oldsha "$(cat "$ROOT/DEPLOYED_COMMIT")"

# Web deploy: leaves nakama/ alone and warns while it differs.
setup_deploy
out="$(full_deploy web)"
assert_eq "web deploy leaves the Nakama bundle" "old bundle" "$(cat "$ROOT/nakama/modules/index.js")"
assert_eq "web deploy leaves nakama/prod.yml" "old prod" "$(cat "$ROOT/nakama/prod.yml")"
assert_eq "web deploy still copies other code" "new code" "$(cat "$ROOT/apps/server/main.ts")"
assert_eq "web deploy writes DEPLOYED_COMMIT" "$SHA" "$(cat "$ROOT/DEPLOYED_COMMIT")"
assert_eq "web deploy writes no DEPLOYED_NAKAMA_COMMIT" "no" "$([ -e "$ROOT/DEPLOYED_NAKAMA_COMMIT" ] && echo yes || echo no)"
out2="$(full_deploy web)"
assert_contains "the warning stays on the next web deploy" "WARNING: nakama/ changed" "$out2"
assert_contains "the warning names the Nakama commit" "commit oldsha" "$out"
setup_deploy
echo nakamasha >"$ROOT/DEPLOYED_NAKAMA_COMMIT"
out="$(full_deploy web)"
assert_contains "the warning prefers DEPLOYED_NAKAMA_COMMIT" "commit nakamasha" "$out"
assert_eq "DEPLOYED_NAKAMA_COMMIT is not overwritten by a web deploy" nakamasha "$(cat "$ROOT/DEPLOYED_NAKAMA_COMMIT")"
setup_deploy
out="$(full_deploy web)"
assert_eq "web deploy runs host-deploy web" "host-deploy web" "$(cat "$HOST_DEPLOY_LOG")"
assert_contains "web deploy warns when nakama/ changed" "WARNING: nakama/ changed" "$out"
setup_deploy
cp -r "$NEWTREE/nakama/." "$ROOT/nakama/"
out="$(full_deploy web)"
assert_not_contains "web deploy is quiet when nakama/ is the same" "WARNING" "$out"
setup_deploy
out="$(full_deploy full)"
assert_not_contains "full deploy gives no nakama warning" "WARNING" "$out"

# A second deploy while the lock is held is refused.
setup_deploy
(
	exec 9>"$WORK/lock"
	flock 9
	sleep 3
) &
holder=$!
sleep 0.5
out="$(full_deploy full)"
assert_eq "second deploy is refused while locked" 1 "$?"
assert_contains "lock refusal says so" "another deploy is running" "$out"
kill "$holder" 2>/dev/null
wait "$holder" 2>/dev/null

# --- bmp-deploy: status ---------------------------------------------------------

setup_deploy
: >"$FAKE_DOCKER_LOG"
out="$(SSH_ORIGINAL_COMMAND=status BMP_DEPLOY_ROOT="$ROOT" BMP_DEPLOY_LOCK="$WORK/lock" "$BMP_DEPLOY" 2>&1)"
assert_eq "status exits 0" 0 "$?"
assert_contains "status prints the commit" "deployed_commit: oldsha" "$out"
assert_contains "status prints the Nakama commit (fallback)" "deployed_nakama_commit: oldsha" "$out"
assert_contains "status prints nakama health" "nakama: healthy" "$out"
assert_contains "status prints api health" "api: ok" "$out"
assert_contains "status prints web health" "web: ok" "$out"
assert_not_contains "status changes nothing" " up " "$(cat "$FAKE_DOCKER_LOG")"
assert_not_contains "status does not restart" "restart" "$(cat "$FAKE_DOCKER_LOG")"
assert_eq "status leaves the folder alone" "old bundle" "$(cat "$ROOT/nakama/modules/index.js")"

# --- host-deploy.sh ---------------------------------------------------------------

setup_hd() {
	HD="$WORK/hd"
	rm -rf "$HD"
	mkdir -p "$HD/scripts"
	cat >"$HD/scripts/deploy-color-swap.sh" <<'SWAP'
#!/usr/bin/env bash
echo "color-swap overlay=${COMPOSE_OVERLAY:-}" >>"$FAKE_DOCKER_LOG"
[ -z "${SWAP_FAIL:-}" ]
SWAP
	chmod +x "$HD/scripts/deploy-color-swap.sh"
	cp "$HOST_DEPLOY" "$HD/scripts/host-deploy.sh"
	: >"$FAKE_DOCKER_LOG"
}
run_hd() { # run_hd <mode>
	BMP_HEALTH_TIMEOUT_S=2 BMP_POLL_S=0 "$HD/scripts/host-deploy.sh" "$@" 2>&1
}

setup_hd
out="$(run_hd bogus)"
assert_eq "host-deploy refuses an unknown mode" 2 "$?"

setup_hd
out="$(run_hd full)"
assert_eq "host-deploy full succeeds" 0 "$?"
log="$(cat "$FAKE_DOCKER_LOG")"
assert_contains "full recreates nakama" "up -d --no-deps --force-recreate nakama" "$log"
assert_contains "full uses the balatro overlay" "docker-compose.balatro.yml" "$log"
assert_contains "full swaps the api with the overlay" "color-swap overlay=docker-compose.balatro.yml" "$log"
assert_contains "full builds web" "build web" "$log"
assert_contains "full starts web" "up -d --no-deps web" "$log"
assert_contains "full reloads nginx" "exec bmp-nginx nginx -s reload" "$log"
first="$(grep -nE 'force-recreate nakama' <<<"$log" | cut -d: -f1)"
second="$(grep -nE 'color-swap' <<<"$log" | cut -d: -f1)"
third="$(grep -nE 'build web' <<<"$log" | cut -d: -f1)"
fourth="$(grep -nE 'up -d --no-deps web' <<<"$log" | cut -d: -f1)"
fifth="$(grep -nE 'nginx -s reload' <<<"$log" | cut -d: -f1)"
if [ "$first" -lt "$second" ] && [ "$second" -lt "$third" ] && [ "$third" -lt "$fourth" ] && [ "$fourth" -lt "$fifth" ]; then
	ok "full steps run in order"
else
	bad "full steps run in order ($first $second $third $fourth $fifth)"
fi

setup_hd
out="$(run_hd web)"
assert_eq "host-deploy web succeeds" 0 "$?"
log="$(cat "$FAKE_DOCKER_LOG")"
assert_not_contains "web does not touch nakama" "nakama" "$log"
assert_contains "web swaps the api" "color-swap" "$log"
assert_contains "web reloads nginx" "nginx -s reload" "$log"

setup_hd
out="$(SWAP_FAIL=1 run_hd full)"
assert_eq "failed api swap stops the script" 1 "$?"
assert_not_contains "no web build after a failed swap" "build web" "$(cat "$FAKE_DOCKER_LOG")"

setup_hd
out="$(FAKE_DOCKER_FAIL="build web" run_hd web)"
assert_eq "failed web build stops the script" 1 "$?"
assert_not_contains "no nginx reload after a failed build" "nginx -s reload" "$(cat "$FAKE_DOCKER_LOG")"

setup_hd
out="$(FAKE_DOCKER_FAIL="force-recreate nakama" run_hd full)"
assert_eq "failed nakama recreate stops the script" 1 "$?"
assert_not_contains "no api swap after a failed nakama step" "color-swap" "$(cat "$FAKE_DOCKER_LOG")"

setup_hd
out="$(FAKE_DOCKER_FAIL="wget" run_hd web)"
assert_eq "an unanswering site fails the script" 1 "$?"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
