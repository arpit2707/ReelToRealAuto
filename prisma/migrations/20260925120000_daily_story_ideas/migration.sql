-- Daily Instagram story ideas. Idempotent so a retried boot (Render runs
-- `prisma migrate deploy` on every start) never fails on objects that exist.

-- CreateTable
CREATE TABLE IF NOT EXISTS "StorySettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappNumber" TEXT,
    "instagramChannelId" TEXT,
    "businessDescription" TEXT,
    "keywordDatabase" TEXT NOT NULL DEFAULT 'in',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StoryBatch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "forDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATING',
    "waRecipient" TEXT,
    "selectedOptionId" TEXT,
    "publishedMediaId" TEXT,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StoryOption" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "idea" TEXT NOT NULL,
    "imagePrompt" TEXT NOT NULL,
    "seedKeyword" TEXT NOT NULL,
    "imageData" BYTEA,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "finalImageData" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StorySettings_orgId_key" ON "StorySettings"("orgId");
CREATE UNIQUE INDEX IF NOT EXISTS "StoryBatch_orgId_forDate_key" ON "StoryBatch"("orgId", "forDate");
CREATE INDEX IF NOT EXISTS "StoryBatch_status_createdAt_idx" ON "StoryBatch"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "StoryOption_batchId_position_key" ON "StoryOption"("batchId", "position");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StorySettings" ADD CONSTRAINT "StorySettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "StoryBatch" ADD CONSTRAINT "StoryBatch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "StoryOption" ADD CONSTRAINT "StoryOption_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StoryBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
