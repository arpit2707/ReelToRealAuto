-- Post context (captions, seller notes), per-page profiles, and scheduling:
-- several batches a day (the seller's own photos), reminders, item per option.

-- StoryBatch: DAILY vs OWN, reminder flag; a day may now hold several batches.
ALTER TABLE "StoryBatch"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'DAILY',
  ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "StoryBatch_orgId_forDate_key";
CREATE INDEX IF NOT EXISTS "StoryBatch_orgId_forDate_idx" ON "StoryBatch"("orgId", "forDate");

-- StoryOption: where the image came from and which catalog item it promotes.
ALTER TABLE "StoryOption"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'AI',
  ADD COLUMN IF NOT EXISTS "offeringId" TEXT;

-- PageProfile
CREATE TABLE IF NOT EXISTS "PageProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "description" TEXT,
    "audience" TEXT,
    "tone" TEXT,
    "language" TEXT,
    "faqs" JSONB,
    "offeringIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PageProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PageProfile_channelId_key" ON "PageProfile"("channelId");
CREATE INDEX IF NOT EXISTS "PageProfile_orgId_idx" ON "PageProfile"("orgId");

DO $$ BEGIN
  ALTER TABLE "PageProfile" ADD CONSTRAINT "PageProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PageProfile" ADD CONSTRAINT "PageProfile_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SocialPost
CREATE TABLE IF NOT EXISTS "SocialPost" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channelId" TEXT,
    "platform" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "caption" TEXT,
    "mediaUrl" TEXT,
    "permalink" TEXT,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'META',
    "taggedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SocialPost_orgId_postId_key" ON "SocialPost"("orgId", "postId");

DO $$ BEGIN
  ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Posts tagged before this migration already have their links; mark them as
-- tagged so the new "tag once" rule does not send them to the AI again.
INSERT INTO "SocialPost" ("id", "orgId", "platform", "postId", "caption", "mediaUrl", "permalink", "taggedAt", "updatedAt")
SELECT DISTINCT ON ("orgId", "postId")
  gen_random_uuid()::text, "orgId", "platform", "postId", "caption", "mediaUrl", "permalink", "createdAt", CURRENT_TIMESTAMP
FROM "PostOfferingLink"
ORDER BY "orgId", "postId", "createdAt" ASC
ON CONFLICT ("orgId", "postId") DO NOTHING;
