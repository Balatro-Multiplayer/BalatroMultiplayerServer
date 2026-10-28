#!/bin/sh
# Keeps nginx's error log (nginx/nginx.conf) under 7 days old. The image's
# entrypoint runs this before nginx starts (docker-compose.yml mounts it into
# /docker-entrypoint.d/); it starts a loop that, every ROTATE_SECONDS, renames
# error.log to error.log.<unix time>, has nginx reopen its log, and deletes
# each renamed file KEEP_SECONDS after that time. A line leaves error.log at
# most ROTATE_SECONDS after it is written, and its file goes at most
# ROTATE_SECONDS after KEEP_SECONDS: at most 6 days and 2 hours in all.
# Deletion goes by the time in the name, not the file's mtime, so a file
# nginx still writes to (a reopen that failed) goes on time too.
# `rotate-error-log.sh once` runs one pass and exits (the repo's test).
ROTATE_SECONDS=3600
KEEP_SECONDS=518400
DIR=${ERROR_LOG_DIR:-/var/log/nginx/errors}

pass() {
	now=$(date +%s)
	if [ -s "$DIR/error.log" ]; then
		mv "$DIR/error.log" "$DIR/error.log.$now" && nginx -s reopen
	fi
	for file in "$DIR"/error.log.*; do
		[ -e "$file" ] || continue
		at=${file##*.}
		case $at in
			'' | *[!0-9]*) rm -f "$file" ;;
			*) [ $((now - at)) -lt "$KEEP_SECONDS" ] || rm -f "$file" ;;
		esac
	done
}

if [ "${1:-}" = once ]; then
	pass
	exit 0
fi

(
	while true; do
		sleep "$ROTATE_SECONDS"
		pass
	done
) </dev/null >/dev/null 2>&1 &
