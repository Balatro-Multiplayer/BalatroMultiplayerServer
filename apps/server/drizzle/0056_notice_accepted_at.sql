-- players.notice_accepted_at: when the player accepted the Notice version in
-- tos_accepted_version. Written by the website login and the Nakama mirror.
ALTER TABLE "players" ADD COLUMN IF NOT EXISTS "notice_accepted_at" timestamp with time zone;
