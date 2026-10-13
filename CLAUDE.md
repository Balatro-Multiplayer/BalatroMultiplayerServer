# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this project is

**BalatroMultiplayerAPI-Server** — backend for *Balatro Multiplayer* (BMP), a mod that adds online multiplayer to the game Balatro. Two halves:

- **Nakama** (`nakama/`, a TypeScript runtime module) is the game backend: Steam login, lobbies, gameplay relay, ranked matchmaking (Elo, seasons, decay), moderated chat, bans, replay logs and anti-cheat checks, spectating, and restart checkpoints. Game clients talk only to Nakama.
- **Express** (`apps/server`, TypeScript + PostgreSQL via Drizzle ORM) is the website and webadmin backend. Nakama's finished games are mirrored into Postgres, so the website's stats, leaderboards and history and the webadmin's moderation views read Postgres.

pnpm/Turborepo monorepo. **Branch note:** `main` is a stale legacy branch still on the old Lua/Lobby.lua + plain-WebSocket architecture (`Server/src/*.js`). Diffing against `main` is *not* a meaningful way to isolate recent work — use `git log --oneline` on the active branch itself instead.

## Repo layout

```
apps/
  server/     — Express/TypeScript API: website + webadmin, Nakama mirror
  web/        — Next.js 16 site: marketing, docs (Fumadocs/MDX), web admin frontend
  moderation/ — chat classifier service (see its README)
nakama/       — Nakama runtime module (src/ -> modules/index.js via build.mjs),
                prod.yml / local.yml configs, scripts/import-legacy-ratings.sh
packages/
  internal/   — @v-rtualized/bmp-internal public stub; real impl is a private package
                injected at deploy time (e.g. launcher-integrity ChallengeStrategy).
                Its absence = "feature disabled", not an error.
  types/      — @bmp/types, shared across server/web/internal
docker-compose.yml        — postgres + nakama + api (blue/green) + moderation + nginx + web
docker-compose.local.yml  — local overlay: plain HTTP, Nakama on 127.0.0.1:7350, dev keys
turbo.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json
```

### `nakama/src/`
```
main.ts      — InitModule: registers RPCs, hooks, the bmp_lobby match
auth.ts      — Steam login (custom-auth hook, steam:<id>), device login for dev
lobby/       — the authoritative lobby match: relay, chat, spectate, forfeits,
               replay-log storage + hash check (log_check), anti-cheat gates,
               checkpoints, retention
actions/     — server-refereed ready/start and result settlement
matchmaking/ — queue, integrity gate, matched-lobby creation
rating/      — Elo, seasons/decay/soft reset, legacy-rating claim, admin overwrite
chat/        — moderation-service bridge with local word-filter fallback
moderation/  — bans, enforcement, reports
player/      — profiles, Discord link, admin profile sync
mirror/      — the outbox Express pulls into Postgres
config.ts    — server config pushed by Express (season, ToS, allowlist, ...)
express.ts   — calls back into Express's /internal/nakama/* routes
```

### `apps/server/src/`
```
main.ts         — Express app, config load + push to Nakama, the mirror,
                  retention, season and cleanup jobs, mod-registry sync
env.ts          — typed env loading (NAKAMA_URL is required)
routes/index.ts — mounts every feature router
features/       — auth (web Steam/Discord login), launcher-integrity, mods,
                  nakama (mirror job, integrity, /internal/nakama routes),
                  ratings (seasons, void-replay Elo), replay-log (read-only),
                  reports, stats, webadmin, ...
infrastructure/
  db/           — Drizzle schema.ts, migrate.ts, void-match.ts
  gateways/     — per-domain data access
  nakama/       — admin RPC client (callNakamaRpc), config/integrity push
middleware/, state/ (web sessions only), shared/, contracts/, tests/
```

## Build / run / test

- Root: `pnpm dev|build|test|lint` → delegates to `turbo <task>`. `pnpm migrate` / `pnpm generate` target the server (Drizzle).
- Server (`apps/server`): `dev` = `tsx watch src/main.ts`; `build` = `tsc`; `test` = vitest; lint/format = Biome.
- Nakama (`nakama`): `pnpm build` (esbuild → `modules/index.js`, which the container loads), `npx vitest run`.
- `docker compose up -d` brings up the stack; locally set `COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml`.
- Live end-to-end checks run from ClaudeControl (`e2e/nakama_*`), driving real game clients against the local stack.

## How the pieces talk

1. **Game client ↔ Nakama.** Clients log in with a Steam ticket (Nakama custom auth, verified by `auth.ts`), then use Nakama RPCs and one realtime socket. Gameplay actions are relayed by the authoritative `bmp_lobby` match.
2. **Nakama → Express.** `express.ts` calls `/internal/nakama/*` (guarded by `INTERNAL_API_KEY`) for player sync, launcher-integrity session start/answers, ranked-readiness, and Discord linking.
3. **Express → Nakama.** `callNakamaRpc` calls server-only admin RPCs with `NAKAMA_HTTP_KEY`: config push, bans, notifications, profile sync, ratings overwrite, run purge, lobby kick/close.
4. **The mirror.** Nakama appends finished matches, runs and logs, ratings, chat lines, anti-cheat flags, conflicts and forfeits to an outbox; `features/nakama/mirror.job.ts` pulls it every few seconds, writes it to Postgres idempotently, and acks.
5. **Ranked mode keys.** Postgres and the website key ranked boards as `ranked:<mode>`; Nakama keys them by the bare `<mode>`. The mirror and the void push convert.
6. **Seasons.** The Postgres `seasons` table is the source of truth; Express rolls seasons over hourly and pushes the current one to Nakama, which carries ratings over lazily (soft reset) and decays inactive ratings. The website applies the same decay at read time.

## Replay log / anti-cheat

- The client recorder sends replay events through the lobby match; Nakama stores each player's log and, at the run's end, recomputes the SHA-256 the client sent in its `chk` event (`lobby/log_check.ts`). A mismatch, or an implausible elapsed-time/hand-count ratio (`lobby/anticheat.ts`), flags the run and keeps it out of rating; the flag reaches the webadmin service queue through the mirror.
- Logs are `[t, opcode, args]` **positional tuples** — the client's timeline reader (`MPAPI.playback.build_timeline`) reads `ev[1]/ev[2]/ev[3]`. Postgres stores the mirrored copy as JSON → gzip → base64 in `matchRunLogs.compressedEvents`.
- **Schema-v2 card refs**: card-referencing opcodes encode card identity via `RLOG.card_ref` — a JSON array whose first element's sign disambiguates: positive `id` = already seen this run (`[id, tag...]`), negative `-id` = first seen (`[-id, kind, ident..., tag...]`). Up to 3 trailing tags (`e:`/`ed:`/`s:`) capture mid-run mutations.
- Retention: 180 days unless flagged, in both Nakama (purged daily by Express's retention job) and Postgres (purged hourly).
- **`GET /api/runs/mine`** (website "My Matches") and **`GET /api/runs/:runId/replay`** (participant- or moderator-gated) read the mirrored copy.

## REST API surface (mounted in `routes/index.ts`)

`/api/auth` (website Steam/Discord login, ToS, preferences, account deletion), `/api/reports`, `/api/runs`, `/api/stats` (leaderboards/seasons/history), `/api/launcher`, `/api/blog`, `/api/mods`, `/api/r2modman/updates`, `/api/webadmin` (moderator/admin-gated), `/admin`, `/internal/nakama` (Nakama only). Plus `GET /health`.

## Database (Postgres + Drizzle, `infrastructure/db/schema.ts`, ~24 tables)

`players` (soft-delete via `deletedAt`; `nakamaUserId` links the Nakama account), `refreshTokens` (unused), `chatLogs`, `actionLogs`, `serverConfig`, `modVersions`, `flaggedMessages`, `reports`/`reportedLobbyMessages`, `chatAllowlist`, `matchmakingMatches`, `matchResultConflicts`, `matchmakingRatings`, `leaderboardCache` (unused), `seasons`, `modBranches`/`modReleases`, `playerBans`, `playerMutes`, `lobbyRuns` + `matchRunLogs` (replay/anti-cheat), `modRegistry`/`modRegistryVersions`/`modProfiles`/`modProfileEntries` (mod catalog + ranked allowlisting), `launcherIntegrityEvents`.

Postgres holds durable/audit data (bans, reports, seasons, mod catalog) and the mirrored copy of Nakama's games, ratings and chat. Live game state lives in Nakama (match state, storage, leaderboards).

## Other docs in-repo

- Root `README.md` — dev setup, docker-compose usage, and a "dev impersonation" workflow for running multiple local game clients (env vars `BMP_IMPERSONATE_NAME`/`BMP_IMPERSONATE_ID`, read by the sibling mod repo's `../BalatroMultiplayerAPI/dev/init.lua`).
- `apps/web/content/docs/*.mdx` — player-facing docs site (Fumadocs/MDX): getting started, ranked matchmaking rules/FAQ, gamemodes, rulesets, approved/banned mods, private-server guide. This is user documentation, not architecture.
- `packages/internal/src/index.ts` — public stub explaining the private-package injection pattern used for launcher-integrity and other non-public features.
