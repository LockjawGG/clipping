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

-- 1.01: the Agent Brain page's event store. Append-only; nothing joins to it,
-- so an install that predates it simply starts recording from the upgrade.
CREATE TABLE IF NOT EXISTS "telemetry_events" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "targetActor" TEXT,
    "taskId" TEXT,
    "summary" TEXT NOT NULL,
    "status" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedTokensAvoided" INTEGER,
    "latencyMs" INTEGER,
    "model" TEXT,
    "metaJson" TEXT,
    CONSTRAINT "telemetry_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "telemetry_events_ts_idx" ON "telemetry_events"("ts");
CREATE INDEX IF NOT EXISTS "telemetry_events_eventType_idx" ON "telemetry_events"("eventType");
CREATE INDEX IF NOT EXISTS "telemetry_events_actor_idx" ON "telemetry_events"("actor");
CREATE INDEX IF NOT EXISTS "telemetry_events_taskId_idx" ON "telemetry_events"("taskId");
