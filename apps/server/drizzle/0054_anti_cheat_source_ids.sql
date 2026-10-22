-- An anti_cheat item is per flagged player: its source id becomes
-- 'runId:playerId' (it was the run id alone, so the unique (type, source)
-- key dropped every flagged player after the first in a run).
UPDATE "service_queue_items"
SET "source_id" = "source_id" || ':' || "subject_player_id"
WHERE "item_type" = 'anti_cheat' AND "subject_player_id" IS NOT NULL AND position(':' in "source_id") = 0;--> statement-breakpoint
-- The players that bug dropped: flagged in a run that has an item already.
INSERT INTO "service_queue_items" ("item_type", "source_id", "subject_player_id", "summary", "priority", "created_at")
SELECT 'anti_cheat', l."run_id" || ':' || l."player_id", l."player_id", 'Anti-cheat flag (' || l."flag_reason" || ')', 60, coalesce(l."finalized_at", now())
FROM "match_run_logs" l
WHERE l."flag_reason" IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM "service_queue_items" q
		WHERE q."item_type" = 'anti_cheat' AND q."source_id" LIKE l."run_id" || ':%'
	)
ON CONFLICT ("item_type", "source_id") DO NOTHING;
