# BalatroMultiplayerServer

The backend for Balatro Multiplayer (BMP), a mod platform that adds online
multiplayer to Balatro. Game clients talk to a [Nakama](https://heroiclabs.com/nakama/)
server running the runtime module in [`nakama/`](nakama); the website and the
web admin panel run on an Express API backed by PostgreSQL.

In production the game backend is `nakama.balatromp.com` and the website is
`new.balatromp.com`.

## The BMP repos

All under [github.com/Balatro-Multiplayer](https://github.com/Balatro-Multiplayer):

| Repo | What it is |
|------|------------|
| **BalatroMultiplayerServer** (this repo) | Nakama runtime module, website/admin API, website, chat moderation service |
| BalatroMultiplayerAPI | Client mod library (global `MPAPI`): connection, lobbies, actions, gamemodes, replay recorder |
| BalatroMultiplayerPvP | PvP mod built on MPAPI |
| BalatroMultiplayerSpeedrunning | Speedrun (SPDRN) gamemodes built on MPAPI |

The client mods only ever talk to Nakama. Nothing in a game client calls the
Express API directly.

### The `legacy` branch

`main` is the Nakama-based platform. The pre-Nakama server (the MQTT/EMQX-era
Express server and the older socket server) is frozen on the
[`legacy`](https://github.com/Balatro-Multiplayer/BalatroMultiplayerServer/tree/legacy) branch. It is kept for reference only; diffing `main`
against it is not a useful way to find what changed recently.

## Architecture

A pnpm + Turborepo monorepo:

```
nakama/            Nakama TypeScript runtime module (the game backend)
apps/server/       Express API: website + web admin backend, Nakama mirror
apps/web/          Next.js website: leaderboards, stats, match history, admin UI
apps/moderation/   Stateless chat-moderation verdict service (local classifier)
packages/types/    @bmp/types, shared types for server/web/internal
packages/internal/ Public stub for private, deploy-time-only features
nginx/             Reverse-proxy config (prod, local, blue/green upstream)
scripts/           deploy-color-swap.sh (blue/green API deploy)
```

### `nakama/` — the game backend

Bundled by esbuild from `nakama/src` into `nakama/modules/index.js`, which the
Nakama container loads. It owns everything live:

- **Login**: Steam session tickets via a custom-auth hook; device login for
  local development only.
- **Lobbies**: an authoritative `bmp_lobby` match that relays gameplay actions,
  referees ready/start and result reporting, handles spectating, forfeits,
  rejoin and checkpoint/restore across restarts.
- **Ranked**: matchmaking queue (solo and group), Elo ratings, seasons with
  soft reset and inactivity decay, legacy-rating carry-over.
- **Chat**: lobby chat judged by the moderation service, with a local word
  filter as fallback.
- **Replay logs and anti-cheat**: per-player replay logs with an end-of-run
  hash check and plausibility checks; flagged runs are kept out of ratings.
- **Moderation**: bans, mutes, reports, account standing, achievements and
  avatar unlocks.
- **Mirror outbox**: finished games, ratings, chat and flags are appended to an
  outbox that the API pulls into Postgres.

### `apps/server/` — the API

Express + Drizzle ORM on PostgreSQL. It serves the website and web admin
(`/api/*`), mirrors Nakama's outbox into Postgres, owns seasons, the mod
catalog and server config, and pushes config/bans/rating changes back into
Nakama through server-only admin RPCs. Nakama calls back into it on
`/internal/nakama/*`. Postgres holds durable and audit data plus the mirrored
copy of Nakama's games; live game state stays in Nakama.

### `apps/web/` — the website

Next.js (App Router). Public pages (leaderboards, stats, player profiles,
match history, downloads) and the moderator/admin panel. It reaches the API
server-side through a proxy route.

### `apps/moderation/` — chat moderation

A stateless `POST /moderate` service that classifies chat with a local GGUF
model. It runs as several replicas behind an internal nginx load balancer that
only Nakama calls. The model file is not in the repo; see
[`apps/moderation/README.md`](apps/moderation/README.md) for staging it and for
the shadow-mode default.

### `packages/internal/`

A public stub. Some features (for example the launcher-integrity challenge
strategy) have private implementations that replace this package at deploy
time. Without them the feature is simply disabled.

## Local development

Requirements: Node 22, pnpm (version pinned in `package.json`), Docker with
Compose.

```sh
pnpm install
```

### Environment files

There are two `.env` files, both git-ignored:

- **`apps/server/.env`**: read by the API containers. Copy
  [`apps/server/.env.example`](apps/server/.env.example) and fill it in. The API
  refuses to start without `DATABASE_URL`, `JWT_SECRET`, `PLAYER_ID_SALT`,
  `ADMIN_SECRET` and `NAKAMA_URL` (`STEAM_WEB_API_KEY` too, in production).
  The rest are optional integrations (Discord OAuth, GitHub releases, mod index
  sync) or dev flags such as `DEV_AUTO_VERIFY_LAUNCHER`. `BMP_SERVER_KIND`
  (`official`, `community` or `dev`; unset means `official`) decides which dev
  flags are allowed: the API and Nakama refuse to start as `official` with any
  of them on.
- **root `.env`**: read by Docker Compose. Locally it typically sets
  `COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml` and, if you want
  real Steam login, `STEAM_WEB_API_KEY` and `PLAYER_ID_SALT` (the same salt as
  the API). A deployed stack also needs `NAKAMA_SESSION_KEY`,
  `NAKAMA_REFRESH_KEY`, `NAKAMA_HTTP_KEY`, `NAKAMA_CONSOLE_PASSWORD`,
  `NAKAMA_CONSOLE_SIGNING_KEY` and `INTERNAL_API_KEY`; the Nakama container
  refuses to start without them.

Chat, ranked, casual queue and lobby creation are toggled at runtime from the
admin config page (stored in Postgres), not through env vars.

### Running the stack

[`docker-compose.yml`](docker-compose.yml) is the production-shaped stack
(Postgres, Nakama, blue/green API, moderation replicas, nginx, web).
[`docker-compose.local.yml`](docker-compose.local.yml) is the local overlay:
plain HTTP, public placeholder keys, Nakama on `127.0.0.1:7350` (console on
7351), the API on `127.0.0.1:8788`, the website on `127.0.0.1:3000`, device
login enabled, and a single moderation replica.

```sh
export COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml   # or set it in the root .env
docker compose up -d --build
docker compose logs -f nakama
docker compose down            # add -v to wipe the database volume
```

The API runs its migrations as part of a deploy (see below); on a fresh local
database run them once:

```sh
docker compose run --rm --no-deps api-blue sh -c "pnpm --filter balatro-multiplayer-api-server migrate"
```

After changing anything under `nakama/src`, rebuild the bundle and restart
Nakama:

```sh
pnpm --filter bmp-nakama-modules build
docker compose restart nakama
```

To work on the API or website outside Docker, `pnpm dev` runs every package's
watch mode through Turbo.

### Running several local game clients

The local Nakama accepts device login, so a game client can sign in as any
test account without a Steam ticket. The client mod's dev overrides (in
BalatroMultiplayerAPI's `dev/init.lua`) read two environment variables at
launch:

- `BMP_IMPERSONATE_NAME=<name>`: any name; the same name is the same account
- `BMP_IMPERSONATE_ID=<id>`: exact id (takes precedence)

Start one game instance per player, each with a different value. Leave both
unset on an instance that should sign in through real Steam.

## Tests, typecheck and lint

```sh
pnpm test                                        # all unit tests (Vitest) via Turbo
pnpm lint                                        # Biome
pnpm build                                       # tsc / next build for every package
pnpm --filter bmp-nakama-modules typecheck       # the Nakama module
pnpm --filter balatro-multiplayer-web typecheck  # the website
```

Database schema changes go through Drizzle:

```sh
pnpm generate    # write a new migration from apps/server/src/infrastructure/db/schema.ts
pnpm migrate     # apply migrations
```

Live checks against a running local stack live in
[`nakama/scripts/live/`](nakama/scripts/live); each is a standalone Node
script (`node nakama/scripts/live/mirror.live.mjs`) that drives throwaway
device-auth players through Nakama and checks the result in Postgres.

## Deployment

Production runs the same Compose stack on a single host behind Cloudflare,
with nginx as the only entry point. The API is deployed blue/green:
[`scripts/deploy-color-swap.sh`](scripts/deploy-color-swap.sh) builds the
inactive API color, runs migrations, health-checks it, switches
`nginx/upstream.conf` over and stops the old color without dropping requests.
Nakama, the website and the moderation replicas are rebuilt and restarted with
`docker compose up -d`. Nakama gets a shutdown grace period so open lobbies
checkpoint themselves and resume after a restart.

Use the base compose file alone for a dedicated host, or add a host-specific
overlay with `COMPOSE_OVERLAY=<file>` when sharing a host with other services.

## License

See [`apps/server/LICENSE`](apps/server/LICENSE) and
[`apps/web/LICENSE`](apps/web/LICENSE).
