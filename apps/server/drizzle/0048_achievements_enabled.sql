-- The avatar achievements switch, pushed to Nakama (config-sync.ts). Off:
-- switch it on from webadmin only after the avatar reset (0049 here, and
-- Nakama's admin_avatars_reset) has run.
ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "achievements_enabled" boolean DEFAULT false NOT NULL;
