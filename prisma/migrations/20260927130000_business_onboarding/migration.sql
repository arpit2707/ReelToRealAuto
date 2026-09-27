-- Additive only: nullable/defaulted columns, safe to re-run on the live database.
-- Existing sellers start with onboardedAt/activatedAt NULL, so automated replies stay off
-- until they answer the setup questions once.

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
