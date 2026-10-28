-- Avatar achievements are on by default, and on for the existing config row.
-- No avatar reset is needed first: the reset never deletes progress, and the
-- API fills progress from the stored games at boot (admin_achievements_backfill).
ALTER TABLE "server_config" ALTER COLUMN "achievements_enabled" SET DEFAULT true;--> statement-breakpoint
UPDATE "server_config" SET "achievements_enabled" = true;
