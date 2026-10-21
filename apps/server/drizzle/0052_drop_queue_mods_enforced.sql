-- The allowed-mods check is always on (Nakama's standing/): the
-- queue_mods_enforced switch migration 0051 added is gone.
ALTER TABLE "server_config" DROP COLUMN IF EXISTS "queue_mods_enforced";
