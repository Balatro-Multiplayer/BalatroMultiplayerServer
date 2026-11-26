-- The Cocktail deck Ranked plays (set on the website's Ranked Cocktail page). One row; no row means the mod's built-in recipe.
-- random: three decks rolled for every Cocktail tile of a game's Draft instead
-- (decks is then empty); same_every_tile: one roll per game for every tile.
CREATE TABLE IF NOT EXISTS "ranked_cocktail" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" varchar(64) NOT NULL,
	"decks" jsonb NOT NULL,
	"random" boolean DEFAULT false NOT NULL,
	"same_every_tile" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
