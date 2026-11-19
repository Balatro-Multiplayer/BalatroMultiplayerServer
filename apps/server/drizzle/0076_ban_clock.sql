-- A timed chat, queue or account ban runs from the first time the player is told. duration_ms keeps its length; expires_at stays null until Nakama starts the clock. Bans issued before this have their end and no length.
ALTER TABLE "player_bans" ADD COLUMN IF NOT EXISTS "duration_ms" bigint;
