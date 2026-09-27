-- Daily posts: seller-chosen times, destinations, trend keywords, edit loop.
ALTER TABLE "StorySettings"
  ADD COLUMN "sendTime" TEXT NOT NULL DEFAULT '09:00',
  ADD COLUMN "postTime" TEXT NOT NULL DEFAULT '19:00',
  ADD COLUMN "optionCount" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "destinations" TEXT[] DEFAULT ARRAY['IG_STORY']::TEXT[],
  ADD COLUMN "facebookChannelId" TEXT,
  ADD COLUMN "nicheKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "StoryBatch"
  ADD COLUMN "trendKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "editingOptionId" TEXT,
  ADD COLUMN "scheduledFor" TIMESTAMP(3),
  ADD COLUMN "publishedTargets" JSONB;

CREATE INDEX "StoryBatch_status_scheduledFor_idx" ON "StoryBatch"("status", "scheduledFor");

ALTER TABLE "StoryOption"
  ADD COLUMN "label" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "caption" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
