-- Legacy game logs: games from the legacy website's uploaded logs, in the replay event format, keyed by the salted Discord id hash.
CREATE TABLE IF NOT EXISTS "legacy_game_logs" (
	"id" integer PRIMARY KEY NOT NULL,
	"discord_id_hash" text,
	"owner_name" varchar(128),
	"opponent_name" varchar(128),
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"time_exact" boolean NOT NULL,
	"result" varchar(8),
	"deck" varchar(64),
	"stake" varchar(64),
	"seed" varchar(32),
	"beta_season" integer,
	"beta_match_key" varchar(64),
	"owner_events" text NOT NULL,
	"opponent_events" text,
	"shared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legacy_game_logs_owner_idx" ON "legacy_game_logs" USING btree ("discord_id_hash","started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legacy_game_logs_beta_idx" ON "legacy_game_logs" USING btree ("discord_id_hash","beta_season","beta_match_key");
