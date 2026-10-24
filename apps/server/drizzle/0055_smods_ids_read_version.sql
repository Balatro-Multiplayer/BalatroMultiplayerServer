-- mod_registry.smods_ids_read_version: the pin version smods_ids was read
-- from (or set by an admin for). The API boot reads the ids of any pin where
-- it is not the pinned version, so a pin whose files declare no id is read
-- once, not at every boot. A pin that already has ids counts as read.
ALTER TABLE "mod_registry" ADD COLUMN IF NOT EXISTS "smods_ids_read_version" varchar(64);--> statement-breakpoint
UPDATE "mod_registry"
SET "smods_ids_read_version" = "ranked_version"
WHERE "ranked_version" IS NOT NULL AND cardinality("smods_ids") > 0;
