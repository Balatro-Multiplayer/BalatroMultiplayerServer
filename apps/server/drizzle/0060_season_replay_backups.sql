-- What the owner's season replay overwrote: the Nakama ratings and leaderboard
-- records, the Postgres rating rows and the results it changed.
CREATE TABLE IF NOT EXISTS "season_replay_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"season" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL
);
