# BalatroMultiplayerAPI-Server

The backend for Balatro Multiplayer. Game clients talk to
[Nakama](https://heroiclabs.com/nakama/), running the runtime module in
[nakama](nakama): Steam login, lobbies, ranked matchmaking with Elo,
per-season leaderboards, moderated chat, replays and anti-cheat. A TypeScript +
Express server backed by PostgreSQL (via Drizzle ORM), in
[apps/server](apps/server), runs the website and the web admin panel; Nakama's
finished games are mirrored into Postgres for it.

## How to set up a Dev Server

### Enviroment

Copy [.env.example](apps/server/.env.example) to `.env` and fill it in.

Required:

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Signs website auth JWTs |
| `PLAYER_ID_SALT` | Salt for hashing Steam/Discord IDs (≥32 chars) |
| `ADMIN_SECRET` | Guards `POST /admin` endpoints (≥32 chars) |
| `NAKAMA_URL` | Nakama's HTTP API, e.g. `http://nakama:7350` |

There are more secrets in .env.example but some default to values you probably want to keep, like the location of the database, and some you don't need like Steam and Discord. If you want to test a real Steam login you will need to provide a Steam Web API key (in the root `.env`, which Nakama reads too).

A deployed stack also needs these in the root `.env`, which the `nakama`
service refuses to start without: `NAKAMA_SESSION_KEY`, `NAKAMA_REFRESH_KEY`,
`NAKAMA_HTTP_KEY`, `NAKAMA_CONSOLE_PASSWORD`, `NAKAMA_CONSOLE_SIGNING_KEY`,
`INTERNAL_API_KEY`, `STEAM_WEB_API_KEY` and `PLAYER_ID_SALT`.

Flags:

| Variable | Purpose |
|----------|---------|
| `CHAT_ENABLED` | Disable or enable text chat from a server level |
| `TESTING_MODE` | Require accounts to have a `tester` privilige to queue or create a lobby |
| `RANKED_ENABLED` | Disable or enable ranked matchmaking from a server level |

### Running

The [docker-compose.yml](docker-compose.yml) at the repo root brings up the whole
stack on one network. The API container runs migrations automatically on start.

From the `BalatroMultiplayerAPI-Server` directory:

```sh
docker compose up -d --build      # build + start everything in the background
docker compose logs -f api        # follow the API server logs
docker compose down               # stop (add -v to also wipe the db/broker volumes)
```

For local development layer
[docker-compose.local.yml](docker-compose.local.yml) on top: plain HTTP, Nakama
published on `127.0.0.1:7350` (console on 7351) with public placeholder keys,
and device login for impersonated clients. Either pass it explicitly
(`docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`) or set
`COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml` in your local `.env`
so plain `docker compose ...` picks it up automatically.

Rebuild the Nakama module after changing [nakama/src](nakama/src)
(`pnpm --dir nakama build`) and restart the `nakama` container.

## Launching multiple clients (dev impersonation)

The local stack's Nakama accepts device logins (`ALLOW_DEVICE_AUTH`), which
lets a game client log in as another player without a real Steam ticket. The
mod's dev overrides in
[BalatroMultiplayerAPI/dev/init.lua](../BalatroMultiplayerAPI/dev/init.lua) wire
this to two environment variables read at launch, set one before starting a game
instance and that instance authenticates as the chosen account:

- `BMP_IMPERSONATE_NAME=<name>` - any name; the same name is the same account
- `BMP_IMPERSONATE_ID=<id>` - exact id (takes precedence)

To exercise a two-player match locally:

1. **Start the stack** (`docker compose up -d --build` with the local overlay).
2. **Launch one game instance per client**, each with a different impersonation
   variable set:
   ```sh
   BMP_IMPERSONATE_NAME=Player001 balatro     # host
   BMP_IMPERSONATE_NAME=Player002 balatro     # guest, separate instance
   ```
   The host creates a lobby; each guest joins by its code. Leave a variable unset
   on any instance you want to authenticate with real Steam instead.