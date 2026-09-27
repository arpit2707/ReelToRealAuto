-- Additive only: nullable/defaulted columns, safe to re-run on the live database.
-- Every existing workspace starts inactive (activatedAt NULL) until the seller
-- finishes onboarding.

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "businessName" TEXT,
ADD COLUMN IF NOT EXISTS "audience" TEXT,
ADD COLUMN IF NOT EXISTS "replyTone" TEXT,
ADD COLUMN IF NOT EXISTS "replyLanguage" TEXT,
ADD COLUMN IF NOT EXISTS "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);
