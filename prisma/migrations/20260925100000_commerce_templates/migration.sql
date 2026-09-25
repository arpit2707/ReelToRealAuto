-- Additive only: nullable columns or columns with defaults, safe on the live database.

-- AlterTable
ALTER TABLE "AbandonedCart" ADD COLUMN IF NOT EXISTS "itemsSummary" TEXT,
ADD COLUMN IF NOT EXISTS "lastReminderError" TEXT,
ADD COLUMN IF NOT EXISTS "recoveredAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "recoveredOrderId" TEXT;

-- AlterTable
ALTER TABLE "EcommerceOrder" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "checkoutToken" TEXT,
ADD COLUMN IF NOT EXISTS "confirmationError" TEXT,
ADD COLUMN IF NOT EXISTS "confirmationSentAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "itemsSummary" TEXT;

-- AlterTable
ALTER TABLE "ShopifyStore" ADD COLUMN IF NOT EXISTS "cartTemplateNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "codTemplateName" TEXT,
ADD COLUMN IF NOT EXISTS "templateLanguage" TEXT NOT NULL DEFAULT 'en';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AbandonedCart_orgId_createdAt_idx" ON "AbandonedCart"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EcommerceOrder_orgId_createdAt_idx" ON "EcommerceOrder"("orgId", "createdAt");
