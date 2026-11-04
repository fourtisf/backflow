-- CreateTable
CREATE TABLE "TelegramLink" (
    "wallet" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("wallet")
);

-- CreateTable
CREATE TABLE "TelegramLinkCode" (
    "code" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "VanityMint" (
    "pubkey" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "VanityMint_pkey" PRIMARY KEY ("pubkey")
);

-- CreateIndex
CREATE INDEX "TelegramLink_chatId_idx" ON "TelegramLink"("chatId");

-- CreateIndex
CREATE INDEX "VanityMint_usedAt_idx" ON "VanityMint"("usedAt");
