-- SHA-256 of the injector file(s) a ranked pin ships (Lovely), so the launcher can verify the deployed file against a server value. Null until read.
ALTER TABLE "mod_registry" ADD COLUMN IF NOT EXISTS "ranked_file_hashes" jsonb;
