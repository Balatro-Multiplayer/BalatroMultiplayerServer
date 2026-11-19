#!/usr/bin/env bash
# One call to the Official server's /api/deploy routes with the deploy token.
# Usage: api-call.sh <GET|POST> <path under /api/deploy> [json body]
# Needs BMP_API_URL and BMP_DEPLOY_TOKEN. Prints the HTTP status code (000
# when the call did not connect) and writes the answer body to BODY_FILE.
# The token goes to curl on stdin, so it never shows in a process list or log.
set -uo pipefail

: "${BMP_API_URL:?BMP_API_URL is not set}"
: "${BMP_DEPLOY_TOKEN:?BMP_DEPLOY_TOKEN is not set}"
method="${1:?method}"
path="${2:?path}"
BODY_FILE="${BODY_FILE:-${RUNNER_TEMP:-/tmp}/deploy-api.json}"

args=(-sS --max-time 60 -o "$BODY_FILE" -w '%{http_code}' -X "$method" -H @- -H 'Content-Type: application/json')
[ -n "${3:-}" ] && args+=(-d "$3")
printf 'Authorization: Bearer %s' "$BMP_DEPLOY_TOKEN" | curl "${args[@]}" "${BMP_API_URL%/}/api/deploy/$path" || echo 000
