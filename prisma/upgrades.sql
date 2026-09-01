-- Idempotent upgrades for portable data directories created by older builds.
-- schema.sql only runs on a fresh cluster; an existing install needs additions
-- applied on every start. Everything here must be safe to run twice.
CREATE TABLE IF NOT EXISTS "user_settings" (
    "userId" TEXT NOT NULL,
    "json" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("userId")
);
DO $$ BEGIN
  ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1.01: the pinned full-video clip gets its own origin.
ALTER TYPE "ClipOrigin" ADD VALUE IF NOT EXISTS 'FULL_VIDEO';
