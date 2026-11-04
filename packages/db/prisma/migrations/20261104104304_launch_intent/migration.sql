-- CreateTable
CREATE TABLE "LaunchIntent" (
    "mint" TEXT NOT NULL,
    "tickerKey" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "metadataUri" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchIntent_pkey" PRIMARY KEY ("mint")
);

-- CreateIndex
CREATE INDEX "LaunchIntent_tickerKey_idx" ON "LaunchIntent"("tickerKey");
