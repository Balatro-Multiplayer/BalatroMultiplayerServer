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
| [BalatroMultiplayerServer](https://github.com/Balatro-Multiplayer/BalatroMultiplayerServer) (this repo) | Nakama runtime module, website/admin API, website, chat moderation service |
| [BalatroMultiplayerAPI](https://github.com/Balatro-Multiplayer/BalatroMultiplayerAPI) | Client mod library (global `MPAPI`): connection, lobbies, actions, gamemodes, replay recorder |
| [BalatroMultiplayerPvP](https://github.com/Balatro-Multiplayer/BalatroMultiplayerPvP) | PvP mod built on MPAPI |
| [BalatroMultiplayerSpeedrunning](https://github.com/Balatro-Multiplayer/BalatroMultiplayerSpeedrunning) | Speedrun (SPDRN) gamemodes built on MPAPI |

The client mods only ever talk to Nakama. Nothing in a game client calls the
Express API directly.

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
  sync) or dev flags such as `DEV_AUTO_VERIFY_LAUNCHER`.
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

## AI Content Disclaimer

This repo does NOT use AI for art or other assets. It
uses generative AI in its development as a tool for writing code. The chat moderation service (`apps/moderation/`) uses a local AI model to
classify chat messages.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for
guidelines.

Changes to ratings, ranked, moderation or the wire contract with the client
mods are heavily scrutinized, so open an issue or ask on
[Discord](https://discord.gg/balatromp) first. A wire contract change also
needs a matching change in
[BalatroMultiplayerAPI](https://github.com/Balatro-Multiplayer/BalatroMultiplayerAPI).
Bug fixes and quality-of-life work are always welcome. Check the
[issues](https://github.com/Balatro-Multiplayer/BalatroMultiplayerServer/issues),
especially those tagged "Help Wanted".

## License

Each part of the repo has its own license:

| Path | License |
|------|---------|
| `apps/server/` | GPL-3.0, see [`apps/server/LICENSE`](apps/server/LICENSE) |
| `apps/web/` | AGPL-3.0, see [`apps/web/LICENSE`](apps/web/LICENSE) |
| `packages/internal/` | Proprietary, see [`packages/internal/LICENSE`](packages/internal/LICENSE) |
