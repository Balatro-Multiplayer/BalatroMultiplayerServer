-- The Discord rank-role bot polls each board for rows written since its last call (updated_at).
CREATE INDEX IF NOT EXISTS "mmr_updated_idx" ON "matchmaking_ratings" USING btree ("mod_id","game_mode","season","updated_at");
