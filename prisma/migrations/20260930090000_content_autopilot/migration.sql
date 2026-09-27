-- WhatsApp edit mode: what is being edited, and since when (it lapses).
ALTER TABLE "StoryBatch" ADD COLUMN IF NOT EXISTS "editingMode" TEXT;
ALTER TABLE "StoryBatch" ADD COLUMN IF NOT EXISTS "editingStartedAt" TIMESTAMP(3);

-- Reel version of a daily post.
ALTER TABLE "StoryOption" ADD COLUMN IF NOT EXISTS "reelVideoData" BYTEA;

-- Seller asked on WhatsApp to confirm an AI post tag.
ALTER TABLE "PostOfferingLink" ADD COLUMN IF NOT EXISTS "askedAt" TIMESTAMP(3);
