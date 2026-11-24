-- The Cocktail deck Ranked plays (set on the website's Ranked Cocktail page). One row; no row means the mod's built-in recipe.
-- random: three decks rolled for every game instead (decks is then empty).
CREATE TABLE IF NOT EXISTS "ranked_cocktail" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" varchar(64) NOT NULL,
	"decks" jsonb NOT NULL,
	"random" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
