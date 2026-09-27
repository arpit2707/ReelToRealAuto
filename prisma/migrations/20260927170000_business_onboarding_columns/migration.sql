-- The business_onboarding migration was recorded as applied on the live
-- database before its final version, so its columns never got created and every
-- BusinessProfile read failed. Re-adds them; IF NOT EXISTS keeps it safe to run
-- anywhere the columns already exist.

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "businessName" TEXT,
ADD COLUMN IF NOT EXISTS "audience" TEXT,
ADD COLUMN IF NOT EXISTS "tone" TEXT,
ADD COLUMN IF NOT EXISTS "replyTone" TEXT,
ADD COLUMN IF NOT EXISTS "language" TEXT,
ADD COLUMN IF NOT EXISTS "replyLanguage" TEXT,
ADD COLUMN IF NOT EXISTS "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "onboardedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);
