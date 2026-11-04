-- AlterTable
ALTER TABLE "Buyback" ADD COLUMN     "feeLamports" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "refundedLamports" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Coin" ADD COLUMN     "holderSyncSlot" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "holderSyncedAt" TIMESTAMP(3),
ADD COLUMN     "lastBuybackAttemptAt" TIMESTAMP(3),
ADD COLUMN     "metadataAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "metadataStatus" TEXT NOT NULL DEFAULT 'ok',
ADD COLUMN     "needsHolderSync" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nextHarvestAt" TIMESTAMP(3),
ADD COLUMN     "tokenProgram" TEXT;

-- AlterTable
ALTER TABLE "HolderState" ADD COLUMN     "lastDecreaseAt" TIMESTAMP(3),
ADD COLUMN     "mismatchAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "StreamCursor" ADD COLUMN     "stuckAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stuckSignature" TEXT,
ADD COLUMN     "stuckSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VaultClaim" ADD COLUMN     "slot" BIGINT;

-- CreateTable
CREATE TABLE "MetadataPin" (
    "uri" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "tickerKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetadataPin_pkey" PRIMARY KEY ("uri")
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "nonce" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "wallet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "tokenHash" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "WorkerLease" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerLease_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "IndexerDeadLetter" (
    "stream" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "IndexerDeadLetter_pkey" PRIMARY KEY ("stream","signature")
);

-- CreateIndex
CREATE INDEX "MetadataPin_creator_createdAt_idx" ON "MetadataPin"("creator", "createdAt");

-- CreateIndex
CREATE INDEX "AuthNonce_expiresAt_idx" ON "AuthNonce"("expiresAt");

-- CreateIndex
CREATE INDEX "AdminSession_wallet_idx" ON "AdminSession"("wallet");

-- CreateIndex
CREATE INDEX "LaunchIntent_creator_idx" ON "LaunchIntent"("creator");

-- CreateIndex
CREATE INDEX "LaunchIntent_expiresAt_idx" ON "LaunchIntent"("expiresAt");

