-- AI provider keys (platform and per workspace), per-service provider choice,
-- and the superadmin audit log. Idempotent because the live database was
-- partly built with `db push`.
CREATE TABLE IF NOT EXISTS "AiProviderKey" (
  "id" TEXT NOT NULL,
  "orgId" TEXT,
  "provider" TEXT NOT NULL,
  "apiKeyEnc" TEXT NOT NULL,
  "keyHint" TEXT NOT NULL,
  "model" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiProviderKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AiProviderKey_orgId_provider_key" ON "AiProviderKey"("orgId", "provider");
-- Postgres treats NULLs as distinct, so the platform rows need their own index.
CREATE UNIQUE INDEX IF NOT EXISTS "AiProviderKey_platform_provider_key" ON "AiProviderKey"("provider") WHERE "orgId" IS NULL;

CREATE TABLE IF NOT EXISTS "AiServiceSetting" (
  "id" TEXT NOT NULL,
  "orgId" TEXT,
  "service" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "tenantCanChoose" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiServiceSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AiServiceSetting_orgId_service_key" ON "AiServiceSetting"("orgId", "service");
CREATE UNIQUE INDEX IF NOT EXISTS "AiServiceSetting_platform_service_key" ON "AiServiceSetting"("service") WHERE "orgId" IS NULL;

CREATE TABLE IF NOT EXISTS "AdminAuditLog" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetOrgId" TEXT,
  "targetUserId" TEXT,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

DO $$ BEGIN
  ALTER TABLE "AiProviderKey" ADD CONSTRAINT "AiProviderKey_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AiServiceSetting" ADD CONSTRAINT "AiServiceSetting_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
