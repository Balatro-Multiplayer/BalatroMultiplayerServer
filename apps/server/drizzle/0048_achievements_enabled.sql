-- The avatar achievements switch, pushed to Nakama (config-sync.ts).
-- 0058 turns it on by default.
ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "achievements_enabled" boolean DEFAULT false NOT NULL;
