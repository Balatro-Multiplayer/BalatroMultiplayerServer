-- The Nakama -> Postgres mirror (features/nakama/mirror): Nakama lobby codes
-- are six characters and get reused, so a match no longer owns its code; and
-- mirrored chat lines carry the outbox key they came from, so a line pulled
-- twice (the API died before acking it) is stored once.
ALTER TABLE "matchmaking_matches" DROP CONSTRAINT IF EXISTS "matchmaking_matches_lobby_code_unique";--> statement-breakpoint
ALTER TABLE "matchmaking_matches" ALTER COLUMN "lobby_code" TYPE varchar(6);--> statement-breakpoint
ALTER TABLE "chat_logs" ADD COLUMN IF NOT EXISTS "mirror_key" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_logs_mirror_key_idx" ON "chat_logs" ("mirror_key") WHERE mirror_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "flagged_messages" ADD COLUMN IF NOT EXISTS "mirror_key" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flagged_messages_mirror_key_idx" ON "flagged_messages" ("mirror_key") WHERE mirror_key IS NOT NULL;
