-- Beta Seasons: ranked history from the Discord queue era, keyed by the salted Discord id hash.
CREATE TABLE IF NOT EXISTS "beta_seasons" (
	"number" integer PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "beta_season_standings" (
	"season" integer NOT NULL,
	"mod_id" varchar(128) NOT NULL,
	"game_mode" varchar(128) NOT NULL,
	"discord_id_hash" text NOT NULL,
	"name" varchar(128) NOT NULL,
	"rank" integer NOT NULL,
	"rating" double precision NOT NULL,
	"peak_rating" double precision,
	"wins" integer NOT NULL,
	"losses" integer NOT NULL,
	"games_played" integer NOT NULL,
	CONSTRAINT "beta_season_standings_season_mod_id_game_mode_discord_id_hash_pk" PRIMARY KEY("season","mod_id","game_mode","discord_id_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "beta_season_games" (
	"season" integer NOT NULL,
	"mod_id" varchar(128) NOT NULL,
	"game_mode" varchar(128) NOT NULL,
	"match_key" varchar(64) NOT NULL,
	"discord_id_hash" text NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"opponent_id_hash" text,
	"opponent_name" varchar(128),
	"result" varchar(8) NOT NULL,
	"rating_after" double precision,
	"rating_change" double precision,
	"deck" varchar(64),
	"stake" varchar(64),
	CONSTRAINT "beta_season_games_season_match_key_discord_id_hash_pk" PRIMARY KEY("season","match_key","discord_id_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beta_standings_board_rank_idx" ON "beta_season_standings" USING btree ("season","mod_id","game_mode","rank");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beta_standings_player_idx" ON "beta_season_standings" USING btree ("discord_id_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beta_games_player_idx" ON "beta_season_games" USING btree ("discord_id_hash","season","game_mode","played_at");
