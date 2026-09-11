-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "brandPersona" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "channelIdentifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenExpiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actions" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "stockQuantity" INTEGER NOT NULL DEFAULT 10,
    "sizes" TEXT[],
    "colors" TEXT[],
    "checkoutUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostMapping" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "caption" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InteractionLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "inboundMessage" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "publicReply" TEXT,
    "privateDm" TEXT,
    "intent" TEXT,
    "sentiment" TEXT,
    "requiresHuman" BOOLEAN NOT NULL DEFAULT false,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "externalEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InteractionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessageStatus" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "phoneNumberId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "recipientWaId" TEXT,
    "status" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorTitle" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessageStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "optInStatus" BOOLEAN NOT NULL DEFAULT true,
    "customAttributes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'MARKETING',
    "language" TEXT NOT NULL DEFAULT 'en_US',
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "components" JSONB NOT NULL,
    "metaTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastCampaign" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "retryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BroadcastCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyStore" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "webhookSecret" TEXT,
    "codConfirmationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "abandonedCartEnabled" BOOLEAN NOT NULL DEFAULT true,
    "orderTrackingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcommerceOrder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerName" TEXT,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "paymentMethod" TEXT NOT NULL DEFAULT 'COD',
    "orderStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "codStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcommerceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbandonedCart" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "cartToken" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerName" TEXT,
    "cartValue" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "checkoutUrl" TEXT NOT NULL,
    "recoveryStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "reminderStage" INTEGER NOT NULL DEFAULT 0,
    "lastReminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbandonedCart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'DEBIT',
    "reason" TEXT NOT NULL,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_userId_orgId_key" ON "OrganizationMember"("userId", "orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_orgId_channelIdentifier_key" ON "Channel"("orgId", "channelIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "Product_orgId_sku_key" ON "Product"("orgId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "PostMapping_orgId_postId_key" ON "PostMapping"("orgId", "postId");

-- CreateIndex
CREATE UNIQUE INDEX "InteractionLog_externalEventId_key" ON "InteractionLog"("externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhookEvent_eventId_key" ON "ProcessedWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WhatsAppMessageStatus_messageId_idx" ON "WhatsAppMessageStatus"("messageId");

-- CreateIndex
CREATE INDEX "WhatsAppMessageStatus_status_createdAt_idx" ON "WhatsAppMessageStatus"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_orgId_phone_key" ON "Contact"("orgId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_orgId_name_language_key" ON "WhatsAppTemplate"("orgId", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_orgId_shopDomain_key" ON "ShopifyStore"("orgId", "shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "EcommerceOrder_orgId_orderId_key" ON "EcommerceOrder"("orgId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AbandonedCart_orgId_cartToken_key" ON "AbandonedCart"("orgId", "cartToken");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_orgId_key" ON "Wallet"("orgId");

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMapping" ADD CONSTRAINT "PostMapping_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMapping" ADD CONSTRAINT "PostMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractionLog" ADD CONSTRAINT "InteractionLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppTemplate" ADD CONSTRAINT "WhatsAppTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastCampaign" ADD CONSTRAINT "BroadcastCampaign_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyStore" ADD CONSTRAINT "ShopifyStore_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcommerceOrder" ADD CONSTRAINT "EcommerceOrder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbandonedCart" ADD CONSTRAINT "AbandonedCart_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
