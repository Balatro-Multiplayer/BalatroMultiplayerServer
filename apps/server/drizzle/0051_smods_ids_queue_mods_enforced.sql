-- Valid account standing. mod_registry.smods_ids: the SMODS mod ids a
-- pinned mod's files declare (its JSON manifest's "id", else a Lua header's
-- "--- MOD_ID:"), read at pin time and admin-overridable; the union over
-- pinned mods is pushed to Nakama as queueAllowedModIds.
-- server_config.queue_mods_enforced: whether Nakama refuses matchmaking to a
-- player whose reported mods aren't all allowed.
ALTER TABLE "mod_registry" ADD COLUMN IF NOT EXISTS "smods_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "queue_mods_enforced" boolean DEFAULT false NOT NULL;
