-- The moderator service queue redesign (features/service-queue): claims,
-- resolution notes, the creation context priority scoring reads, an audit
-- trail per item, warnings, and the lobby instance on mirrored chat lines
-- (the chat context window around a flagged line).
ALTER TABLE "service_queue_items" ALTER COLUMN "source_id" TYPE varchar(80);--> statement-breakpoint
ALTER TABLE "service_queue_items" ADD COLUMN IF NOT EXISTS "claimed_by" text;--> statement-breakpoint
ALTER TABLE "service_queue_items" ADD COLUMN IF NOT EXISTS "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_queue_items" ADD COLUMN IF NOT EXISTS "resolution_notes" text;--> statement-breakpoint
ALTER TABLE "service_queue_items" ADD COLUMN IF NOT EXISTS "context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_queue_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_queue_items_status_priority_idx" ON "service_queue_items" ("status", "priority" DESC, "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_queue_item_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"item_id" integer NOT NULL REFERENCES "service_queue_items"("id") ON DELETE CASCADE,
	"kind" varchar(16) NOT NULL,
	"actor" text NOT NULL,
	"action" varchar(32),
	"note" text,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_queue_item_events_item_idx" ON "service_queue_item_events" ("item_id", "at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_warnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"player_id" uuid NOT NULL REFERENCES "players"("id"),
	"item_id" integer REFERENCES "service_queue_items"("id") ON DELETE SET NULL,
	"message" text NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_warnings_player_idx" ON "player_warnings" ("player_id");--> statement-breakpoint
ALTER TABLE "chat_logs" ADD COLUMN IF NOT EXISTS "lobby_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_logs_lobby_id_sent_idx" ON "chat_logs" ("lobby_id", "sent_at") WHERE lobby_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_reported_idx" ON "reports" ("reported_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_reporter_idx" ON "reports" ("reporter_id");--> statement-breakpoint
-- Items from before scoring get their type's base score (priority.ts).
UPDATE "service_queue_items" SET "priority" = CASE "item_type"
	WHEN 'anti_cheat' THEN 60
	WHEN 'integrity' THEN 60
	WHEN 'report' THEN 40
	WHEN 'match_conflict' THEN 40
	WHEN 'forfeit_reconciliation' THEN 35
	ELSE 20 END
WHERE "priority" IS NULL;
