-- SocialPost: when it was posted and its counts, so the dashboard can list
-- every post newest first, 10 per page. Idempotent because the live database
-- was partly built with `db push`.
ALTER TABLE "SocialPost"
  ADD COLUMN IF NOT EXISTS "postedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "likes" INTEGER,
  ADD COLUMN IF NOT EXISTS "commentsCount" INTEGER;

CREATE INDEX IF NOT EXISTS "SocialPost_orgId_postedAt_idx" ON "SocialPost"("orgId", "postedAt");
