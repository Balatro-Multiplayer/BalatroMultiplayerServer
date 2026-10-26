# BalatroMultiplayerServer

The backend for Balatro Multiplayer (BMP), a mod platform that adds online
multiplayer to Balatro. Game clients talk to a [Nakama](https://heroiclabs.com/nakama/)
server running the runtime module in [`nakama/`](nakama); the website and the
web admin panel run on an Express API backed by PostgreSQL.

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

## Self Hosting and Local Development

[`compose.local.yml`](compose.local.yml) runs a server on your own machine
with plain `docker compose` commands. It does not use `docker-compose.yml`
(the Official server's file). Settings go in a `.env` file in the repo folder
(copy [`.env.example`](.env.example)); every setting is optional.

You can run two kinds of server (`BMP_SERVER_KIND`):

- A **Community server** (the default), to self host: Postgres and Nakama.
  Players log in with Device login, so the server needs no Steam Web API key.
  Casual, Ranked and private lobbies work; ratings stay on this server. It
  uses the committed Nakama bundle, so you need no Node or pnpm. See
  [Run a Community server](#run-a-community-server).
- A **Dev server**, for local development: the same, plus the API, the
  website, a Nakama bundle that rebuilds on save, and every dev flag allowed.
  Game clients connect to it with the [Dev mod](#dev-mod). See
  [Dev server](#dev-server).

### Run a Community server

You need Docker with Compose (Docker Desktop, or Docker Engine with the
Compose plugin) and `git`.

1. Get this repo:

   ```sh
   git clone https://github.com/Balatro-Multiplayer/BalatroMultiplayerServer.git
   cd BalatroMultiplayerServer
   ```

2. Start the server:

   ```sh
   docker compose -f compose.local.yml up -d
   ```

3. Wait until `bmp-nakama` shows `(healthy)`:

   ```sh
   docker compose -f compose.local.yml ps
   ```

4. Join it from a game. Each player follows "Join a Community server" in the
   [MPAPI README](https://github.com/Balatro-Multiplayer/BalatroMultiplayerAPI#join-a-community-server).
   On the machine that runs the server, the address is `127.0.0.1`, port
   `7350`.

Nakama now listens on `127.0.0.1:7350` for game clients. Its console is on
`http://127.0.0.1:7351` (user `admin`, password `localdevpassword` unless you
set `NAKAMA_CONSOLE_PASSWORD`).

Other commands:

```sh
docker compose -f compose.local.yml logs -f nakama   # follow the server log
docker compose -f compose.local.yml down             # stop; add -v to delete all data
git pull && docker compose -f compose.local.yml up -d   # update
```

#### Let other machines join

By default only the machine that runs the server can join. To let other
machines join:

1. Copy [`.env.example`](.env.example) to `.env` in the repo folder.
2. In `.env`, set `NAKAMA_BIND_ADDRESS=0.0.0.0`.
3. In `.env`, give every key in the "Community server" block a long random
   value of your own (`NAKAMA_HTTP_KEY`, `NAKAMA_SESSION_KEY`,
   `NAKAMA_REFRESH_KEY`, `NAKAMA_CONSOLE_PASSWORD`,
   `NAKAMA_CONSOLE_SIGNING_KEY`, `INTERNAL_API_KEY`, `JWT_SECRET`,
   `ADMIN_SECRET`, `PLAYER_ID_SALT`). The defaults are public. Set
   `PLAYER_ID_SALT` once and never change it. Do not change
   `NAKAMA_SERVER_KEY`: the game sends `defaultkey`.
4. Run `docker compose -f compose.local.yml up -d` again.
5. Let TCP port `7350` through your firewall (and your router, for players
   outside your network).

Players then use your machine's address as `server_host`. The connection is
plain, not TLS, so set `server_secure = false`. The console (port `7351`)
stays on your machine.

### Dev server

A Dev server is for contributors. It is a Community server plus the API, the
website, a Nakama bundle that rebuilds on save, and every dev flag allowed.
You need Docker with Compose and `git`. You need Node and pnpm only to run
the tests or to work on the API or the website outside Docker.

1. Get this repo (see [Run a Community server](#run-a-community-server)).

2. Copy [`.env.example`](.env.example) to `.env`, and uncomment the two lines
   of its "Dev server" block:

   ```sh
   BMP_SERVER_KIND=dev
   COMPOSE_PROFILES=dev
   ```

3. Start the server:

   ```sh
   docker compose -f compose.local.yml up --watch
   ```

   This stays in the foreground and shows the logs. To run it in the
   background, use `up -d`, then `docker compose -f compose.local.yml watch`
   when you change `nakama/src`.

4. Wait until `bmp-nakama` and `bmp-api` show `(healthy)` in
   `docker compose -f compose.local.yml ps`.

5. Make the test accounts and a web admin login (see [Test data](#test-data)):

   ```sh
   docker compose -f compose.local.yml run --rm seed
   ```

6. Install the [Dev mod](#dev-mod) next to MPAPI, then start the game.

| Service | Address |
|---|---|
| Nakama, for game clients | `127.0.0.1:7350` (plain, not TLS) |
| Nakama console | `http://127.0.0.1:7351` (user `admin`, password `localdevpassword`) |
| API | `http://127.0.0.1:8788` |
| Website and web admin panel | `http://127.0.0.1:3000` |
| Postgres | in the `bmp-postgres` container only |

#### Change the Nakama code

`nakama-bundle` rebuilds `nakama/modules/index.js` on every save in
`nakama/src`, and `--watch` then restarts Nakama. Commit the rebuilt bundle
with your `nakama/src` change: it is what the container runs. Without the
watcher, rebuild it yourself and restart Nakama:

```sh
pnpm --filter bmp-nakama-modules build
docker compose -f compose.local.yml restart nakama
```

The bundle must stay one plain script (no exports, not minified): Nakama finds
`InitModule` and every handler by its global name.

#### Change the API or the website

The `api` and `web` containers run a built image, so they do not follow your
edits. Rebuild them after a change:

```sh
docker compose -f compose.local.yml up -d --build api web
```

To work on the website with hot reload, stop the `web` container and run it
outside Docker. It uses the API container on `127.0.0.1:8788`:

```sh
docker compose -f compose.local.yml stop web
pnpm install
pnpm --filter balatro-multiplayer-web dev
```

Run the API in Docker: Postgres is not published to your machine, so an API
outside Docker cannot reach it.

A schema change goes through Drizzle (`pnpm generate`, see
[Tests, typecheck and lint](#tests-typecheck-and-lint)). After `up --build`,
the `migrate` service applies the new migration before the API starts.

#### Dev flags

Set these in `.env`. A Dev server allows all four dev flags. A Community
server refuses `ALLOW_RANKED_LOBBIES` and the two `DEV_` flags, and the
Official server refuses all four: Nakama and the API do not start with a
refused flag on. The last two rows are not dev flags: every server kind reads
them.

| Variable | Dev server default | Effect |
|---|---|---|
| `ALLOW_DEVICE_AUTH` | on | Device login (no Steam Web API key needed). |
| `ALLOW_RANKED_LOBBIES` | on | A client may create a ranked lobby directly, without the matchmaker. |
| `DEV_AUTO_VERIFY_LAUNCHER` | off | The API marks every player's launcher as checked. |
| `DEV_FAKE_LAUNCHER_STRATEGY` | off | The API uses a stand-in launcher-integrity challenge when `packages/internal` has none. |
| `LOBBY_GRACE_SECONDS` | 120 | How long a lobby waits for a player who dropped. |
| `RESULT_TIMEOUT_SECONDS` | 60 | How long a lobby waits for the result of a game. |

`true` or `1` turns a flag on, `false` or `0` turns it off. After you change
`.env`, run `up` again: `restart` does not read `.env`.

#### Stop and update

```sh
docker compose -f compose.local.yml down    # stop; add -v to delete all data
git pull && docker compose -f compose.local.yml up --watch --build   # update
```

To empty the databases, see [Test data](#test-data).

`down` stops the services of the profiles in `.env`. If you started extra
profiles on the command line, give the same profiles to `down`.

### Test data

```sh
docker compose -f compose.local.yml run --rm seed    # test players and a web admin login
docker compose -f compose.local.yml run --rm reset   # empty both databases
docker compose -f compose.local.yml restart          # after a reset
```

`seed` makes the Nakama accounts `TestPlayer1` to `TestPlayer4` and prints a
link that logs the website in as the admin `LocalAdmin`. Run it again for a new
link. Both refuse to run on the Official server.

### Dev mod

The Dev mod is a client mod for contributors, in [`dev/client/`](dev/client).
It points the game at a Dev server and lets one game log in as a chosen test
account. Players never install it.

Install it next to MPAPI: copy or symlink `dev/client` into Balatro's `Mods/`
folder (any folder name, for example `Mods/MultiplayerDev`). It needs an MPAPI
with `MPAPI.dev`. It reads these environment variables when the game starts:

| Variable | Effect |
|---|---|
| none | Use the Dev server at `127.0.0.1:7350` (plain, not TLS) and Device login with your Steam id |
| `BMP_SERVER_HOST`, `BMP_SERVER_PORT` | Use this host and port instead (port 443 if `BMP_SERVER_PORT` is not set). The rest stays MPAPI's default: TLS, `defaultkey` and the Official website. So this reaches only a server behind TLS, not a plain Dev server on another machine. |
| `BMP_IMPERSONATE_NAME=<name>` | Log in as that test account (the same name is the same account) |
| `BMP_IMPERSONATE_ID=<id>` | Like `BMP_IMPERSONATE_NAME`, but the display name is `Dev-` and the first 8 characters of the id. Wins over the name. The id is not a Nakama user id: it picks the test account the same way a name does. |
| `BMP_DEV_STEAM_LOGIN=1` | Log in with Steam instead (wins over the two above). The server needs `STEAM_WEB_API_KEY` in `.env`. |

To run several game clients on one Steam account, start each one with a
different `BMP_IMPERSONATE_NAME`. The `seed` accounts are `TestPlayer1` to
`TestPlayer4`.

## AI Content Disclaimer

This mod does NOT use AI for art or other assets. This mod uses generative AI in it's development as a tool for writing code.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines.

Content changes (new cards, blinds, rulesets, formats, or anything that alters competitive balance) are heavily scrutinized, so open an issue or ask on Discord first. Bug fixes and quality-of-life work are always welcome, check the [issues](https://github.com/Balatro-Multiplayer/BalatroMultiplayerServer/issues), especially those tagged "Help Wanted".

## License

See [`apps/server/LICENSE`](apps/server/LICENSE) and
[`apps/web/LICENSE`](apps/web/LICENSE).
