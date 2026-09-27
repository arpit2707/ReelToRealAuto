-- Additive only: new tables and nullable/defaulted columns, safe to re-run on
-- the live database.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "goalState" JSONB;

-- AlterTable
ALTER TABLE "InteractionLog" ADD COLUMN IF NOT EXISTS "action" TEXT,
ADD COLUMN IF NOT EXISTS "offeringIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE IF NOT EXISTS "BusinessProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "industry" TEXT NOT NULL DEFAULT 'APPAREL',
    "description" TEXT,
    "city" TEXT,
    "serviceAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hours" TEXT,
    "policies" JSONB,
    "faqs" JSONB,
    "alertPhone" TEXT,
    "autoTagPosts" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Offering" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PRODUCT',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priceMode" TEXT NOT NULL DEFAULT 'FIXED',
    "priceMin" DOUBLE PRECISION,
    "priceMax" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "attributes" JSONB,
    "actionUrl" TEXT,
    "imageUrl" TEXT,
    "sku" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "externalRef" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "bookable" BOOLEAN NOT NULL DEFAULT false,
    "dailyCapacity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OfferingVariant" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "options" JSONB,
    "price" DOUBLE PRECISION,
    "stock" INTEGER,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OfferingVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PackageItem" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,

    CONSTRAINT "PackageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OfferingBlockedDate" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "booked" INTEGER,
    "note" TEXT,

    CONSTRAINT "OfferingBlockedDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PostOfferingLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "caption" TEXT,
    "mediaUrl" TEXT,
    "permalink" TEXT,
    "offeringId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AI_SUGGESTED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT,
    "likes" INTEGER,
    "commentsCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostOfferingLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PostTagRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "postsSeen" INTEGER NOT NULL DEFAULT 0,
    "suggested" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PostTagRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Lead" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT,
    "offeringId" TEXT,
    "platform" TEXT NOT NULL,
    "contactName" TEXT,
    "contactHandle" TEXT,
    "fields" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "alertSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessProfile_orgId_key" ON "BusinessProfile"("orgId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Offering_orgId_isActive_idx" ON "Offering"("orgId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Offering_orgId_source_externalRef_key" ON "Offering"("orgId", "source", "externalRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OfferingVariant_offeringId_idx" ON "OfferingVariant"("offeringId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PackageItem_packageId_itemId_key" ON "PackageItem"("packageId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OfferingBlockedDate_offeringId_date_key" ON "OfferingBlockedDate"("offeringId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PostOfferingLink_orgId_status_idx" ON "PostOfferingLink"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PostOfferingLink_postId_offeringId_key" ON "PostOfferingLink"("postId", "offeringId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PostTagRun_orgId_createdAt_idx" ON "PostTagRun"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_orgId_status_createdAt_idx" ON "Lead"("orgId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_conversationId_offeringId_key" ON "Lead"("conversationId", "offeringId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Offering" ADD CONSTRAINT "Offering_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "OfferingVariant" ADD CONSTRAINT "OfferingVariant_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "OfferingBlockedDate" ADD CONSTRAINT "OfferingBlockedDate_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PostOfferingLink" ADD CONSTRAINT "PostOfferingLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PostOfferingLink" ADD CONSTRAINT "PostOfferingLink_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PostTagRun" ADD CONSTRAINT "PostTagRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Carry existing products into the catalog once. Sizes become variants so the
-- AI can still answer "size 8 hai?" from the new tables.
INSERT INTO "Offering" ("id","orgId","type","title","description","priceMode","priceMin","currency","actionUrl","sku","source","externalRef","isActive","createdAt","updatedAt")
SELECT gen_random_uuid()::text, p."orgId", 'PRODUCT', p."title", p."description", 'FIXED', p."price", p."currency",
       NULLIF(p."checkoutUrl", ''), p."sku", 'LEGACY_PRODUCT', p."id", true, p."createdAt", NOW()
FROM "Product" p
ON CONFLICT ("orgId","source","externalRef") DO NOTHING;

INSERT INTO "OfferingVariant" ("id","offeringId","label","options","price","stock","position")
SELECT gen_random_uuid()::text, o."id", s.size, jsonb_build_object('size', s.size), p."price",
       -- Product.stockQuantity was one total, not per size: keep "out of stock"
       -- but leave per-size stock unknown rather than copy the total onto each.
       CASE WHEN p."inStock" THEN NULL ELSE 0 END, s.ord::int
FROM "Product" p
JOIN "Offering" o ON o."source" = 'LEGACY_PRODUCT' AND o."externalRef" = p."id"
CROSS JOIN LATERAL unnest(p."sizes") WITH ORDINALITY AS s(size, ord)
WHERE NOT EXISTS (SELECT 1 FROM "OfferingVariant" v WHERE v."offeringId" = o."id");
