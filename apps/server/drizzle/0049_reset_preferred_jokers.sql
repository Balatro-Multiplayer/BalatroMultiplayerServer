-- The avatar reset, Postgres side (Nakama's side is admin_avatars_reset):
-- avatars beyond the defaults are now earned, so every pick goes back to
-- j_joker unless it is a default or a privilege joker the player still holds.
-- Mirrors nakama/src/shared/avatars/catalog.ts (defaults and privilege rules,
-- plus Showman, which staff also grants).
UPDATE "players" SET "preferred_joker" = 'j_joker', "updated_at" = now()
WHERE "preferred_joker" NOT IN (
	'j_joker', 'j_jolly', 'j_zany', 'j_mad', 'j_crazy', 'j_droll',
	'j_sly', 'j_wily', 'j_clever', 'j_devious', 'j_crafty'
)
AND NOT (
	   ("preferred_joker" = 'j_perkeo'      AND 'virtualized' = ANY("privileges"))
	OR ("preferred_joker" = 'j_turtle_bean' AND 'bean'        = ANY("privileges"))
	OR ("preferred_joker" = 'j_vagabond'    AND 'vagabond'    = ANY("privileges"))
	OR ("preferred_joker" = 'j_dusk'        AND 'sizaak'      = ANY("privileges"))
	OR ("preferred_joker" = 'j_burnt'       AND 'lava'        = ANY("privileges"))
	OR ("preferred_joker" = 'j_stone'       AND 'twelve'      = ANY("privileges"))
	OR ("preferred_joker" IN ('j_mime', 'j_ring_master') AND 'staff' = ANY("privileges"))
);
