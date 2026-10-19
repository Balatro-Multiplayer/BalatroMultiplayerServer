-- The group queue switch (Nakama's group casual queue, a private lobby
-- queueing as one party), the sibling of casual_queue_enabled.
ALTER TABLE "server_config" ADD COLUMN "group_queue_enabled" boolean DEFAULT true NOT NULL;
