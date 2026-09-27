-- 20260927130000_business_onboarding was already applied on the live database
-- before these columns were added to it, so Prisma never ran them there and
-- every query on BusinessProfile failed. Additive and safe to re-run.

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "businessName" TEXT,
ADD COLUMN IF NOT EXISTS "replyTone" TEXT,
ADD COLUMN IF NOT EXISTS "replyLanguage" TEXT,
ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);
