-- Post autopilot: text-first rounds the seller picks from on WhatsApp, a brand
-- kit, a cadence, object storage keys, weekly past-post insights and a shared
-- trend cache. Idempotent because the live database was partly built with
-- `db push`.
ALTER TABLE "StorySettings"
  ADD COLUMN IF NOT EXISTS "flow" TEXT NOT NULL DEFAULT 'CONTEXTS',
  ADD COLUMN IF NOT EXISTS "cadenceDays" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "maxPicks" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "brandColors" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "brandThemes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "visualStyle" TEXT,
  ADD COLUMN IF NOT EXISTS "brandDirection" TEXT,
  ADD COLUMN IF NOT EXISTS "contentLanguage" TEXT,
  ADD COLUMN IF NOT EXISTS "avoidTopics" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "StoryBatch"
  ADD COLUMN IF NOT EXISTS "parentBatchId" TEXT,
  ADD COLUMN IF NOT EXISTS "sellerNote" TEXT,
  ADD COLUMN IF NOT EXISTS "destinations" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "StoryOption"
  ADD COLUMN IF NOT EXISTS "imageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "finalImageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "reelVideoKey" TEXT;

CREATE TABLE IF NOT EXISTS "ContentInsight" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "topTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "weakTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "postsAnalyzed" INTEGER NOT NULL DEFAULT 0,
  "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentInsight_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ContentInsight_orgId_key" ON "ContentInsight"("orgId");
DO $$ BEGIN
  ALTER TABLE "ContentInsight" ADD CONSTRAINT "ContentInsight_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "TrendCache" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "values" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrendCache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TrendCache_key_key" ON "TrendCache"("key");
CREATE INDEX IF NOT EXISTS "TrendCache_createdAt_idx" ON "TrendCache"("createdAt");

CREATE INDEX IF NOT EXISTS "StoryBatch_parentBatchId_idx" ON "StoryBatch"("parentBatchId");
