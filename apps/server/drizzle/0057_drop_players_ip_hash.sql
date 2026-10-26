-- players.ip_hash: unused. Network hashes live in Nakama (ADR 0005), and
-- nothing reads or writes this column.
ALTER TABLE "players" DROP COLUMN IF EXISTS "ip_hash";
