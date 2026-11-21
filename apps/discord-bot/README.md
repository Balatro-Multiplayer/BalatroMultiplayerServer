# Discord rank-role bot

Keeps rank roles in the Discord server in step with the Expanded ranked
leaderboard. It replaces the rank roles of the archived Botlatro bot.

- Every 10 minutes (and on `/sync-ranks`) it reads every member, asks the API
  for their standing and adds or removes **only the managed roles**.
- Between sweeps it updates roles within about 30 seconds of a match (below).
- Members with no linked Discord account lose every managed role. No message,
  no DM.
- It starts in **dry run**: it logs what it would change and changes nothing.

## Roles

One rating role plus at most one leaderboard role, like Botlatro:

| Rating role | Rating | Leaderboard role | Place |
| --- | --- | --- | --- |
| Stone | below 675 | Foil | top 50 |
| Steel | 675+ | Holographic | top 10 |
| Gold | 750+ | Polychrome | top 3 |
| Lucky | 900+ | Negative | #1 |
| Glass | 1050+ | | |

- A member holds the narrowest leaderboard role their place fits: #1 has
  Negative, not also Polychrome, Holographic and Foil.
- Places are the public leaderboard's (`/api/stats/leaderboard`, same query).
- No role until 5 games this season (the board's placement games).
- After a season ends, a member keeps last season's rating role (on last
  season's cutoffs) until they play 5 games in the new one. Leaderboard roles
  always follow the current board.

The numbers live in `src/ladders.ts`. A new ladder (say Smallworld) is one more
entry there with its own roles.

### How the cutoffs were picked

Botlatro's cutoffs (Steel 530, Gold 620, Lucky 760, Glass 920) were for a 500
start. 1.0 ratings start at 600 (5 placement games, then K=40, floor 100, decay
only above 1200); the current median is about 633. Each cutoff gives roughly the
same share of players each role had in Beta Season 7, measured on players with
40+ games this season. Glass is a little high on purpose: today's #10 is 1212
against 1378 last season while #100 already matches (969 vs 965), so the top is
still filling in. Re-check near the season's end. Cutoffs stay fixed for the
season; when they change, copy the old ones into `ratingRolesBySeason` under the
ending season's id so the fallback reads them.

## How it works

The bot never reads the database. It calls the API's
`POST /internal/discord-bot/standings` (through the `api` alias, like Nakama)
with `X-BMP-Internal-Key: DISCORD_BOT_API_KEY`. The API hashes the Discord ids
with the salt used at link time and lists the top places in the public board's
order, so the bot needs neither the database URL nor `PLAYER_ID_SALT`. The
request and answer types are shared with the API (`@bmp/types`,
`discord-bot.ts`).

### After each match

Every `MATCH_POLL_SECONDS` (30) the bot calls `POST /internal/discord-bot/changes`
with the cursor from its last call. The API answers with the players whose
rating row changed since then (`updated_at`, so mirrored matches, edits,
voids and season replays or restores all count) and the current top 50. If a linked member played or the top
50 changed, the bot re-checks those members, everyone now in the top 50 and
everyone holding a leaderboard role. One match can push other players across
a boundary, and this catches them.

- It reuses the member cache and the Discord id to player map from the last
  sweep, so a member who links mid-sweep waits for the next sweep.
- The cursor reaches back 2 minutes, so slow writes aren't missed. The API
  sends each row's `updated_at`, and a row the bot already saw doesn't count
  again, so one match means one re-check.
- A tick whose standings read fails keeps its cursor and is redone. A member
  whose role change fails is tried again on the next ticks, 3 tries in all.
  While ticks keep failing (say, a 503 between seasons) the error is logged
  once.
- The cursor is taken just before the first sweep, so matches played while
  that sweep runs (minutes, the first time) still count.
- Ticks skip while a sweep runs; the sweep stays as the safety net (new
  links, decay, missed ticks, a player whose only match was voided). A sweep
  that fails keeps the last links.
- The poll uses the `mmr_updated_idx` index (migration 0076).
- Off in dry run, since each sweep already logs the whole plan.

Safety:

- A failed or partial standings read aborts the sweep before any change.
- Each answer is read in one database snapshot, and a void or result change
  rebuilds the board in one transaction, so the bot never sees a board half
  built.
- All places in a sweep come from one top-50 list (the first request's), so a
  match mid-sweep can't give two members #1.
- An unknown board is refused by the API (400) rather than read as empty.
- Role changes go one role at a time (`PUT`/`DELETE
  /guilds/{guild}/members/{user}/roles/{role}`). It never sends a member's
  full role list, so other roles can't be overwritten.
- 5 members at a time, then 2 seconds' pause.

## Setup

1. **Create the application** in the [Discord Developer Portal](https://discord.com/developers/applications).
   - Bot tab: reset and copy the token.
   - Bot tab: turn on **Server Members Intent** (privileged; the bot can't list
     members without it).
2. **Invite it** with scopes `bot` and `applications.commands` and the
   **Manage Roles** permission (268435456):

   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=268435456
   ```

3. **Place its role.** Server Settings > Roles: drag the bot's role **above every
   rank role**. Discord refuses changes to a role at or above the bot's highest
   one (error 50013). The bot logs any such role at startup.
4. **Configure.** Copy `.env.example` to `apps/discord-bot/.env` and fill it in
   (table below). Put the same `DISCORD_BOT_API_KEY` in `apps/server/.env` and
   restart the API.
5. **Start it.** Every deploy (Full or Web) rebuilds and starts the bot, and
   Docker brings it back after a host reboot. To start it now, without a
   deploy (e.g. right after filling in the `.env`):

   ```sh
   docker compose up -d --build discord-bot
   docker compose logs -f discord-bot
   ```

### Environment

| Variable | Required | |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Bot token. |
| `DISCORD_BOT_CLIENT_ID` | yes | Application id. |
| `DISCORD_GUILD_ID` | yes | The server the roles live in. |
| `DISCORD_BOT_API_KEY` | yes | Shared with the API (`apps/server/.env`). |
| `DISCORD_ROLE_STONE` … `_GLASS` | yes | Rating role ids. |
| `DISCORD_ROLE_FOIL`, `_HOLOGRAPHIC`, `_POLYCHROME`, `_NEGATIVE` | yes | Leaderboard role ids. |
| `SYNC_INTERVAL_MINUTES` | no | Default 10, at most 1440 (a day). |
| `MATCH_POLL_SECONDS` | no | Default 30, from 5 to 3600. `0` turns per-match updates off. |
| `DRY_RUN` | no | Default on. `false` or `0` applies changes. |
| `BMP_API_URL` | no | Default `http://api:8788` (set by compose). |

Any required value missing or malformed: the bot logs one
`[discord-bot] disabled: …` line and then does nothing until restarted.
The same goes for setup mistakes Discord reports at startup: a wrong token,
Server Members Intent off, the bot not in the server or invited without
`applications.commands`. Fix it, then `docker compose restart discord-bot`.
It stays up rather than exiting because compose (`restart: unless-stopped`)
would start it into the same error again and again, and many Discord logins
a day can get the token reset. Other startup errors (network, Discord down)
exit after 2 minutes and compose restarts the bot.

## Dry run, then go live

1. Start with `DRY_RUN` unset. Each sweep logs a line per member it would
   change, e.g. `[discord-bot] [dry-run] alice (1234…): +Gold -Steel`, and a
   summary. `/sync-ranks` runs one on demand.
2. Read the log. The first sweep strips roles from everyone unlinked, so expect
   many removals.
3. Set `DRY_RUN=false` and `docker compose up -d discord-bot`.

The first real sweep can take a while (about 150 members a minute).
`/sync-ranks` replies when it ends, or after 10 minutes says it's still running.

## `/sync-ranks`

Runs a sweep now and replies (only to the caller) with members checked, roles
added and removed, and errors. Registered in the one server only. By default
only members with Manage Roles see it; change that under Server Settings >
Integrations.

## Development

```sh
pnpm --filter balatro-multiplayer-discord-bot test
pnpm --filter balatro-multiplayer-discord-bot lint
```
