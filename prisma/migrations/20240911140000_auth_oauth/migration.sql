-- AlterTable
ALTER TABLE "User" ADD COLUMN "metaUserId" TEXT;
ALTER TABLE "User" ADD COLUMN "authProvider" TEXT;
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_metaUserId_key" ON "User"("metaUserId");

-- CreateTable
CREATE TABLE "OauthState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OauthState_state_key" ON "OauthState"("state");
