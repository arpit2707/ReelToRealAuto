-- Post-aware AI replies: per-post AI switch, comment threads and their reply
-- queue, DM Spotlight, offer type and categories, where a chat started, and
-- the daily-post context request. Every statement is idempotent because the
-- live database was partly built with `db push`.

-- SocialPost: the per-post AI switch.
ALTER TABLE "SocialPost"
  ADD COLUMN IF NOT EXISTS "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "aiEnabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "aiEnabledBy" TEXT,
  ADD COLUMN IF NOT EXISTS "contextRequestedAt" TIMESTAMP(3);

-- Conversation: where the chat started.
ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "sourcePostId" TEXT,
  ADD COLUMN IF NOT EXISTS "sourcePlatform" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceKind" TEXT;

-- Offer type and categories.
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "offerType" TEXT;
ALTER TABLE "PageProfile"
  ADD COLUMN IF NOT EXISTS "offerType" TEXT,
  ADD COLUMN IF NOT EXISTS "categories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Daily posts waiting for the seller's context on WhatsApp.
ALTER TABLE "StoryBatch"
  ADD COLUMN IF NOT EXISTS "awaitingContextPostId" TEXT,
  ADD COLUMN IF NOT EXISTS "awaitingContextAt" TIMESTAMP(3);

-- CommentThread
CREATE TABLE IF NOT EXISTS "CommentThread" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "rootCommentId" TEXT NOT NULL,
    "rootAuthorId" TEXT,
    "rootAuthorName" TEXT,
    "conversationId" TEXT,
    "dmSentAt" TIMESTAMP(3),
    "dmRecipientId" TEXT,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "lastReplyAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommentThread_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CommentThread_orgId_rootCommentId_key" ON "CommentThread"("orgId", "rootCommentId");
CREATE INDEX IF NOT EXISTS "CommentThread_orgId_postId_idx" ON "CommentThread"("orgId", "postId");
CREATE INDEX IF NOT EXISTS "CommentThread_channelId_postId_rootAuthorId_idx" ON "CommentThread"("channelId", "postId", "rootAuthorId");

DO $$ BEGIN
  ALTER TABLE "CommentThread" ADD CONSTRAINT "CommentThread_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CommentReplyJob
CREATE TABLE IF NOT EXISTS "CommentReplyJob" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "text" TEXT NOT NULL,
    "isRoot" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "publicReply" TEXT,
    "privateDm" TEXT,
    "dmSent" BOOLEAN NOT NULL DEFAULT false,
    "replyCommentId" TEXT,
    "error" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'REPLY',
    "commentAt" TIMESTAMP(3),
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommentReplyJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CommentReplyJob_commentId_key" ON "CommentReplyJob"("commentId");
CREATE INDEX IF NOT EXISTS "CommentReplyJob_channelId_status_runAfter_idx" ON "CommentReplyJob"("channelId", "status", "runAfter");
CREATE INDEX IF NOT EXISTS "CommentReplyJob_threadId_idx" ON "CommentReplyJob"("threadId");

DO $$ BEGIN
  ALTER TABLE "CommentReplyJob" ADD CONSTRAINT "CommentReplyJob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CommentReplyJob" ADD CONSTRAINT "CommentReplyJob_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CommentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- DmSpotlight
CREATE TABLE IF NOT EXISTS "DmSpotlight" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DmSpotlight_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DmSpotlight_channelId_postId_key" ON "DmSpotlight"("channelId", "postId");
CREATE INDEX IF NOT EXISTS "DmSpotlight_orgId_channelId_idx" ON "DmSpotlight"("orgId", "channelId");

DO $$ BEGIN
  ALTER TABLE "DmSpotlight" ADD CONSTRAINT "DmSpotlight_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill (decision 7): posts with a seller-confirmed item get the AI on.
-- Posts that only have a link row get a SocialPost first. Daily posts stay
-- off until the seller gives them context (decision 6). "aiEnabledAt" IS NULL
-- keeps a re-run from overriding a seller who switched a post off.
INSERT INTO "SocialPost" ("id", "orgId", "platform", "postId", "caption", "mediaUrl", "permalink", "taggedAt", "updatedAt")
SELECT DISTINCT ON ("orgId", "postId")
  gen_random_uuid()::text, "orgId", "platform", "postId", "caption", "mediaUrl", "permalink", "createdAt", CURRENT_TIMESTAMP
FROM "PostOfferingLink"
WHERE "status" = 'SELLER_CONFIRMED'
ORDER BY "orgId", "postId", "createdAt" ASC
ON CONFLICT ("orgId", "postId") DO NOTHING;

UPDATE "SocialPost" s
SET "aiEnabled" = true, "aiEnabledAt" = CURRENT_TIMESTAMP, "aiEnabledBy" = 'BACKFILL'
WHERE s."aiEnabledAt" IS NULL
  AND s."source" <> 'DAILY_POST'
  AND EXISTS (
    SELECT 1 FROM "PostOfferingLink" l
    JOIN "Offering" o ON o."id" = l."offeringId"
    WHERE l."orgId" = s."orgId" AND l."postId" = s."postId"
      AND l."status" = 'SELLER_CONFIRMED' AND o."isActive" = true
  );

-- Offer type from the industry.
UPDATE "BusinessProfile" SET "offerType" = CASE
    WHEN "industry" IN ('APPAREL', 'FOOTWEAR', 'FOOD') THEN 'PRODUCTS'
    WHEN "industry" IN ('BEAUTY_SERVICE', 'HOTEL', 'TRAVEL', 'REAL_ESTATE') THEN 'SERVICES'
    ELSE 'BOTH'
  END
WHERE "offerType" IS NULL;
