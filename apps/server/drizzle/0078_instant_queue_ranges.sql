-- The instant queue ranges: per ranked queue, the rating floor and ceiling whose players queue among each other at once.
CREATE TABLE IF NOT EXISTS "instant_queue_ranges" (
	"mod_id" varchar(128) NOT NULL,
	"game_mode" varchar(128) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"floor" integer,
	"ceiling" integer,
	"floor_multiplier" real DEFAULT 1 NOT NULL,
	"ceiling_multiplier" real DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instant_queue_ranges_mod_id_game_mode_pk" PRIMARY KEY("mod_id","game_mode")
);
