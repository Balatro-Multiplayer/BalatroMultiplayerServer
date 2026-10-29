-- A score board (PvP) keeps the season best as score text, with a sort key: the
-- normalized array length, then the array from the top entry down. A row
-- compare on (len, rev) gives the OmegaNum order. season_best bigint stays for
-- time_ms and for a score that is one whole number.
ALTER TABLE "matchmaking_ratings" ADD COLUMN IF NOT EXISTS "season_best_len" smallint;--> statement-breakpoint
ALTER TABLE "matchmaking_ratings" ADD COLUMN IF NOT EXISTS "season_best_rev" double precision[];--> statement-breakpoint
ALTER TABLE "matchmaking_ratings" ADD COLUMN IF NOT EXISTS "season_best_text" text;--> statement-breakpoint
-- Existing PvP scores are whole numbers up to the old 1e15 cap, so each is a
-- one-entry array. The rows at exactly 1e15 stay as the score 1e15.
UPDATE "matchmaking_ratings"
SET "season_best_text" = "season_best"::text,
    "season_best_len" = 1,
    "season_best_rev" = ARRAY["season_best"::double precision]
WHERE "mod_id" = 'MultiplayerPvP' AND "season_best" IS NOT NULL AND "season_best_text" IS NULL;
