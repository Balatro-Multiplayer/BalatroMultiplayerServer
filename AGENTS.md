# AGENTS.md

Backend for Balatro Multiplayer. Read `README.md` for the architecture and
setup; this file holds what the code does not say on its own.

This repo is public. Keep secrets, hostnames other than `*.balatromp.com`,
IPs, personal paths and player data out of commits, comments and fixtures.

## Map

- `nakama/src/` — the game backend. `main.ts` registers every RPC, hook and the
  `bmp_lobby` match. Domains: `lobby/` (match, relay, chat, spectate, forfeits,
  checkpoints, `log_check.ts`, `anticheat.ts`), `actions/` (refereed
  ready/start, result settlement), `matchmaking/`, `rating/`, `chat/`,
  `moderation/`, `standing/`, `player/`, `achievements/`, `mirror/` (outbox),
  `config.ts` (config pushed by the API), `express.ts` (calls into the API),
  `admin.ts` (server-only admin RPCs), `testing/fake_nk.ts` (unit-test fake).
- `apps/server/src/` — `main.ts` is the composition root (jobs, config push,
  private-package hook); `routes/index.ts` mounts every feature router and
  constructs services with their dependencies; `features/<domain>/`;
  `infrastructure/db/schema.ts` (Drizzle), `infrastructure/gateways/`
  (per-domain data access), `infrastructure/nakama/admin-client.ts`
  (`callNakamaRpc`); `contracts/` (repository interfaces).
- `apps/web/` (Next.js), `apps/moderation/` (classifier, own README),
  `packages/types` (`@bmp/types`), `packages/internal` (public stub).

## How the pieces talk

1. Client ↔ Nakama only: Steam custom auth (`auth.ts`), RPCs, one realtime
   socket per session (`single_socket`), actions relayed by `bmp_lobby`.
2. Nakama → API: `express.ts` calls `/internal/nakama/*` with
   `INTERNAL_API_KEY` (player sync, launcher integrity, ranked readiness,
   Discord link).
3. API → Nakama: `callNakamaRpc` hits admin RPCs with `NAKAMA_HTTP_KEY`
   (config, bans, notifications, profile sync, rating overwrite, run purge,
   lobby kick/close). It uses `?unwrap` so the body is sent as raw JSON.
4. Mirror: Nakama appends finished games, logs, ratings, chat, flags,
   conflicts and forfeits to an outbox; `features/nakama/mirror.job.ts` pulls,
   writes Postgres idempotently, then acks. Website and admin read Postgres.
5. Seasons: the Postgres `seasons` table is the source of truth; the API
   rolls them hourly and pushes the current one. Nakama carries ratings over
   lazily and applies decay; the website applies the same decay at read time,
   so change both together.

## Gotchas

- `nakama/modules/index.js` is generated and committed: it is what the
  container runs. Rebuild it (`pnpm --filter bmp-nakama-modules build`) in the
  same change as any `nakama/src` edit, then restart the `nakama` container.
- The lobby metadata key `drafted_stake` (`DRAFTED_STAKE_KEY` in
  `actions/registry.ts`) is a contract with the PvP mod: the host writes the
  stake it drafted, and `mpapi_restart_game` restarts on it. The host writes the
  empty string when a new game starts, so a stale draft is ignored.
- The Nakama bundle must stay a plain script (ESM, no exports, unminified):
  Nakama finds `InitModule` and every handler by global name.
- Match state round-trips through Go between calls. Keep it to plain objects
  and arrays (no `Set`/`Map`) and return new values instead of mutating nested
  ones in place; see the header of `lobby/state.ts`.
- System-owned storage uses `SYSTEM_USER_ID` from `lobby/protocol.ts`.
- Ranked board keys: Postgres and the website use `ranked:<mode>`, Nakama uses
  bare `<mode>`. The mirror and the void push convert; convert at those
  boundaries too.
- Replay logs are positional `[t, opcode, args]` tuples (the client's
  `MPAPI.playback.build_timeline` reads them by index). Card-referencing
  opcodes use schema-v2 card refs: a JSON array whose first element is a
  positive id (seen before) or negative id (first sighting, followed by kind
  and identity), plus up to three trailing mutation tags (`e:`/`ed:`/`s:`).
  Postgres stores the mirrored log as JSON → gzip → base64 in
  `matchRunLogs.compressedEvents`. Retention is 180 days unless flagged.
- `socket.max_message_size_bytes` in `nakama/local.yml` and `prod.yml` must
  stay above the relay's `MAX_PARAMS_BYTES`; `src/socket_limit.test.ts`
  enforces it.
- `NAKAMA_SERVER_KEY` must match the key the client mod ships.
- `PLAYER_ID_SALT` is shared by the API and Nakama and is never rotated:
  stored Steam/Discord ids are hashed with it.
- `packages/internal` is replaced by a private package at deploy time. An
  unset integrity strategy means "feature disabled", not an error.
  `packages/internal/src/challenge-strategy.ts` may exist locally untracked;
  leave it uncommitted.
- Feature flags for chat, ranked, casual queue and lobby creation live in the
  `server_config` table (admin config page), not in env.
- Migrations do not run on API boot (blue/green would race them). Run
  `pnpm migrate` explicitly; new schema goes through `pnpm generate`.
- Chat calls `moderation-lb`; if it is down chat fails closed unless
  `MODERATION_REMOTE=off`, which uses the local word filter.
- Local-only switches: `ALLOW_DEVICE_AUTH`, `ALLOW_RANKED_LOBBIES`,
  `DEV_AUTO_VERIFY_LAUNCHER`, `DEV_FAKE_LAUNCHER_STRATEGY`. Keep them out of
  any deployed config.
- To isolate recent work, use `git log` on `main`; the `legacy` branch is the
  frozen MQTT-era server.

## Coding style

1. Self-describing names; comment only a non-obvious *why* (the code's
   existing header comments are the model).
2. Structure as namespace: the folder and file path say what a thing is
   (`nakama/src/rating/season.ts`, `features/ratings/season.job.ts`).
3. One responsibility per module; one RPC/route family per file.
4. Dependency inversion: services take their infrastructure as injected
   dependencies typed by `contracts/` interfaces, wired in the composition
   root (`routes/index.ts`, `main.ts`). Put new queries in
   `infrastructure/gateways/`; some older webadmin/stats routes still query
   `db` directly, so move those into a gateway when you touch them.
5. Errors as values at I/O boundaries: return `Result<T, E>` from
   `shared/utils/result.ts` (API) or `src/shared/result.ts` (Nakama) with a
   closed error union (see `NakamaRpcError`). Throw only for bugs.
6. Domain concepts are closed unions, enums or `as const` tables, not loose
   strings.
7. Pure computation apart from effects: rules take plain data and `now` and
   return new data (`lobby/state.ts`, `rating/elo.ts`); a thin layer does the
   `nk.*`/DB/HTTP calls.

Formatting is Biome: tabs, single quotes, no semicolons.

## Verifying a change

- Unit: `pnpm test` (Vitest). Nakama logic is tested against
  `testing/fake_nk.ts`; API tests mock `db` in `src/tests/setup.ts`.
- Types: `pnpm build`, plus `pnpm --filter bmp-nakama-modules typecheck` and
  `pnpm --filter balatro-multiplayer-web typecheck`.
- Live, against the local stack (`docker-compose.local.yml`): rebuild the
  bundle, restart Nakama, then run the relevant
  `node nakama/scripts/live/<area>.live.mjs`. These use throwaway device-auth
  players with a test prefix and query Postgres in the `bmp-postgres`
  container. Unit tests alone do not prove a Nakama change: Go round-tripping
  and socket behaviour only show up live. Client-level checks drive real game
  clients (ClaudeControl tooling) against the same stack.
