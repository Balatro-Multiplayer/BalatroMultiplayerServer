-- Nakama account id for players who sign in through POST /api/auth/nakama
-- (Nakama verifies the Steam ticket, the API maps the account's steam_id onto
-- the player). Null for players who have only used /api/auth/steam.
ALTER TABLE "players" ADD COLUMN "nakama_user_id" uuid;
CREATE UNIQUE INDEX IF NOT EXISTS "players_nakama_user_id_idx" ON "players" ("nakama_user_id") WHERE nakama_user_id IS NOT NULL;
