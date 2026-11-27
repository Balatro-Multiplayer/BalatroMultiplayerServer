-- The pin proxy serves the zip the release workflow posts, so the zip is kept with the switch row and the GitHub asset URL goes.
ALTER TABLE "mod_pin_proxy_switches" ADD COLUMN IF NOT EXISTS "zip_bytes" bytea;
ALTER TABLE "mod_pin_proxy_switches" ADD COLUMN IF NOT EXISTS "zip_sha256" varchar(64);
ALTER TABLE "mod_pin_proxy_switches" DROP COLUMN IF EXISTS "asset_url";
