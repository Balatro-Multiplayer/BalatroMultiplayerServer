-- A ranked pin served through the Server's proxy of a GitHub release asset while its Thunderstore version waits for approval, and the timer that moves it to Thunderstore.
CREATE TABLE IF NOT EXISTS "mod_pin_proxy_switches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"mod_id" varchar(128) NOT NULL REFERENCES "mod_registry"("id") ON DELETE CASCADE,
	"version" varchar(64) NOT NULL,
	"asset_url" text NOT NULL,
	"asset_name" varchar(255) NOT NULL,
	"proxy_url" text NOT NULL,
	"proxy_hash" varchar(64) NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"note" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "mod_pin_proxy_switches_mod_version_idx" ON "mod_pin_proxy_switches" ("mod_id", "version");
CREATE INDEX IF NOT EXISTS "mod_pin_proxy_switches_due_idx" ON "mod_pin_proxy_switches" ("state", "next_check_at");
