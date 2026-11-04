-- CreateEnum
CREATE TYPE "CoinStatus" AS ENUM ('CURVE', 'MIGRATING', 'GRADUATED');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "Venue" AS ENUM ('CURVE', 'CPMM', 'JUPITER');

-- CreateTable
CREATE TABLE "Coin" (
    "mint" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "platformConfig" TEXT NOT NULL,
    "cpmmPoolId" TEXT,
    "feeKeyNftMint" TEXT,
    "name" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "tickerKey" TEXT NOT NULL,
    "tickerSlot" TEXT,
    "description" TEXT,
    "imageUri" TEXT,
    "metadataUri" TEXT,
    "website" TEXT,
    "x" TEXT,
    "telegram" TEXT,
    "avatarSeed" INTEGER NOT NULL DEFAULT 0,
    "creator" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 6,
    "supply" BIGINT NOT NULL,
    "launchedViaUs" BOOLEAN NOT NULL DEFAULT true,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "hiddenReason" TEXT,
    "status" "CoinStatus" NOT NULL DEFAULT 'CURVE',
    "virtualBase" BIGINT NOT NULL DEFAULT 0,
    "virtualQuote" BIGINT NOT NULL DEFAULT 0,
    "realBase" BIGINT NOT NULL DEFAULT 0,
    "realQuote" BIGINT NOT NULL DEFAULT 0,
    "curveQuoteLamports" BIGINT NOT NULL DEFAULT 0,
    "graduationTargetLamports" BIGINT NOT NULL,
    "priceLamportsPerToken" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "mcapUsd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "vol24hUsd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "change24hPct" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "holderCount" INTEGER NOT NULL DEFAULT 0,
    "buybackBudget" BIGINT NOT NULL DEFAULT 0,
    "paidToHoldersLamports" BIGINT NOT NULL DEFAULT 0,
    "buybackCount" INTEGER NOT NULL DEFAULT 0,
    "rewardDust" BIGINT NOT NULL DEFAULT 0,
    "forfeitPool" BIGINT NOT NULL DEFAULT 0,
    "buybacksPaused" BOOLEAN NOT NULL DEFAULT false,
    "payoutsPaused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graduatedAt" TIMESTAMP(3),
    "lastSlot" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Coin_pkey" PRIMARY KEY ("mint")
);

-- CreateTable
CREATE TABLE "Trade" (
    "signature" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "coinMint" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "quoteLamports" BIGINT NOT NULL,
    "tokenAmount" BIGINT NOT NULL,
    "platformFee" BIGINT NOT NULL,
    "creatorFee" BIGINT NOT NULL,
    "protocolFee" BIGINT NOT NULL,
    "feeExact" BOOLEAN NOT NULL DEFAULT false,
    "isBuyback" BOOLEAN NOT NULL DEFAULT false,
    "venue" "Venue" NOT NULL,
    "slot" BIGINT NOT NULL,
    "blockTime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("signature","eventIndex")
);

-- CreateTable
CREATE TABLE "Candle" (
    "coinMint" TEXT NOT NULL,
    "tf" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "o" DECIMAL(20,2) NOT NULL,
    "h" DECIMAL(20,2) NOT NULL,
    "l" DECIMAL(20,2) NOT NULL,
    "c" DECIMAL(20,2) NOT NULL,
    "volLamports" BIGINT NOT NULL DEFAULT 0,
    "hasBuyback" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("coinMint","tf","openTime")
);

-- CreateTable
CREATE TABLE "BalanceEvent" (
    "id" BIGSERIAL NOT NULL,
    "coinMint" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "balance" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "blockTime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BalanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HolderState" (
    "coinMint" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "twabAccumulator" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "balanceAtLastPayout" BIGINT NOT NULL DEFAULT 0,
    "decreasedSincePayout" BOOLEAN NOT NULL DEFAULT false,
    "receivedTotal" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "HolderState_pkey" PRIMARY KEY ("coinMint","wallet")
);

-- CreateTable
CREATE TABLE "ExcludedAccount" (
    "address" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExcludedAccount_pkey" PRIMARY KEY ("address","scope")
);

-- CreateTable
CREATE TABLE "FeeAccrual" (
    "tradeSignature" TEXT NOT NULL,
    "tradeEventIndex" INTEGER NOT NULL,
    "coinMint" TEXT NOT NULL,
    "platformFee" BIGINT NOT NULL,
    "holdersPart" BIGINT NOT NULL,
    "platformPart" BIGINT NOT NULL,
    "claimId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeAccrual_pkey" PRIMARY KEY ("tradeSignature","tradeEventIndex")
);

-- CreateTable
CREATE TABLE "VaultClaim" (
    "id" TEXT NOT NULL,
    "signature" TEXT,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "claimedLamports" BIGINT NOT NULL DEFAULT 0,
    "expectedLamports" BIGINT NOT NULL DEFAULT 0,
    "toBuybackLamports" BIGINT NOT NULL DEFAULT 0,
    "toTreasuryLamports" BIGINT NOT NULL DEFAULT 0,
    "buybackTransferSig" TEXT,
    "treasuryTransferSig" TEXT,
    "mismatchPpm" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "VaultClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Buyback" (
    "id" TEXT NOT NULL,
    "coinMint" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "chunk" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "venue" "Venue" NOT NULL,
    "signature" TEXT,
    "solSpent" BIGINT NOT NULL,
    "quotedTokens" BIGINT NOT NULL DEFAULT 0,
    "minTokensOut" BIGINT NOT NULL DEFAULT 0,
    "tokensBought" BIGINT NOT NULL DEFAULT 0,
    "priceImpactBps" INTEGER,
    "holderCount" INTEGER NOT NULL DEFAULT 0,
    "dustCarried" BIGINT NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Buyback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardCredit" (
    "buybackId" TEXT NOT NULL,
    "coinMint" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "weight" DECIMAL(40,0) NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "RewardCredit_pkey" PRIMARY KEY ("buybackId","wallet")
);

-- CreateTable
CREATE TABLE "Pending" (
    "coinMint" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pending_pkey" PRIMARY KEY ("coinMint","wallet")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "coinMint" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "totalAmount" BIGINT NOT NULL DEFAULT 0,
    "forfeitedAmount" BIGINT NOT NULL DEFAULT 0,
    "rolledOverAmount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutItem" (
    "payoutId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "signature" TEXT,
    "batch" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "PayoutItem_pkey" PRIMARY KEY ("payoutId","wallet")
);

-- CreateTable
CREATE TABLE "Harvest" (
    "id" TEXT NOT NULL,
    "coinMint" TEXT NOT NULL,
    "signature" TEXT,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "solAmount" BIGINT NOT NULL DEFAULT 0,
    "tokenAmount" BIGINT NOT NULL DEFAULT 0,
    "solToBuyback" BIGINT NOT NULL DEFAULT 0,
    "solToPlatform" BIGINT NOT NULL DEFAULT 0,
    "tokensToHolders" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Harvest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationFlag" (
    "id" TEXT NOT NULL,
    "coinMint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "JobLog" (
    "id" BIGSERIAL NOT NULL,
    "job" TEXT NOT NULL,
    "key" TEXT,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamCursor" (
    "stream" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "signature" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreamCursor_pkey" PRIMARY KEY ("stream")
);

-- CreateIndex
CREATE UNIQUE INDEX "Coin_poolId_key" ON "Coin"("poolId");

-- CreateIndex
CREATE UNIQUE INDEX "Coin_cpmmPoolId_key" ON "Coin"("cpmmPoolId");

-- CreateIndex
CREATE UNIQUE INDEX "Coin_tickerSlot_key" ON "Coin"("tickerSlot");

-- CreateIndex
CREATE INDEX "Coin_status_idx" ON "Coin"("status");

-- CreateIndex
CREATE INDEX "Coin_vol24hUsd_idx" ON "Coin"("vol24hUsd");

-- CreateIndex
CREATE INDEX "Coin_createdAt_idx" ON "Coin"("createdAt");

-- CreateIndex
CREATE INDEX "Coin_tickerKey_idx" ON "Coin"("tickerKey");

-- CreateIndex
CREATE INDEX "Coin_creator_idx" ON "Coin"("creator");

-- CreateIndex
CREATE INDEX "Trade_coinMint_blockTime_idx" ON "Trade"("coinMint", "blockTime");

-- CreateIndex
CREATE INDEX "Trade_wallet_idx" ON "Trade"("wallet");

-- CreateIndex
CREATE INDEX "Trade_slot_idx" ON "Trade"("slot");

-- CreateIndex
CREATE INDEX "BalanceEvent_coinMint_wallet_blockTime_idx" ON "BalanceEvent"("coinMint", "wallet", "blockTime");

-- CreateIndex
CREATE INDEX "BalanceEvent_coinMint_slot_idx" ON "BalanceEvent"("coinMint", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceEvent_signature_coinMint_wallet_key" ON "BalanceEvent"("signature", "coinMint", "wallet");

-- CreateIndex
CREATE INDEX "HolderState_coinMint_balance_idx" ON "HolderState"("coinMint", "balance");

-- CreateIndex
CREATE INDEX "HolderState_wallet_idx" ON "HolderState"("wallet");

-- CreateIndex
CREATE INDEX "ExcludedAccount_scope_idx" ON "ExcludedAccount"("scope");

-- CreateIndex
CREATE INDEX "FeeAccrual_coinMint_idx" ON "FeeAccrual"("coinMint");

-- CreateIndex
CREATE INDEX "FeeAccrual_claimId_idx" ON "FeeAccrual"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultClaim_signature_key" ON "VaultClaim"("signature");

-- CreateIndex
CREATE UNIQUE INDEX "Buyback_idempotencyKey_key" ON "Buyback"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Buyback_signature_key" ON "Buyback"("signature");

-- CreateIndex
CREATE INDEX "Buyback_coinMint_createdAt_idx" ON "Buyback"("coinMint", "createdAt");

-- CreateIndex
CREATE INDEX "Buyback_status_idx" ON "Buyback"("status");

-- CreateIndex
CREATE INDEX "RewardCredit_coinMint_wallet_idx" ON "RewardCredit"("coinMint", "wallet");

-- CreateIndex
CREATE INDEX "Pending_wallet_idx" ON "Pending"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payout_coinMint_round_idx" ON "Payout"("coinMint", "round");

-- CreateIndex
CREATE INDEX "PayoutItem_signature_idx" ON "PayoutItem"("signature");

-- CreateIndex
CREATE INDEX "PayoutItem_wallet_idx" ON "PayoutItem"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "Harvest_signature_key" ON "Harvest"("signature");

-- CreateIndex
CREATE INDEX "Harvest_coinMint_createdAt_idx" ON "Harvest"("coinMint", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationFlag_coinMint_idx" ON "ModerationFlag"("coinMint");

-- CreateIndex
CREATE INDEX "JobLog_job_createdAt_idx" ON "JobLog"("job", "createdAt");

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HolderState" ADD CONSTRAINT "HolderState_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeAccrual" ADD CONSTRAINT "FeeAccrual_tradeSignature_tradeEventIndex_fkey" FOREIGN KEY ("tradeSignature", "tradeEventIndex") REFERENCES "Trade"("signature", "eventIndex") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeAccrual" ADD CONSTRAINT "FeeAccrual_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeAccrual" ADD CONSTRAINT "FeeAccrual_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "VaultClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Buyback" ADD CONSTRAINT "Buyback_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardCredit" ADD CONSTRAINT "RewardCredit_buybackId_fkey" FOREIGN KEY ("buybackId") REFERENCES "Buyback"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pending" ADD CONSTRAINT "Pending_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Harvest" ADD CONSTRAINT "Harvest_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationFlag" ADD CONSTRAINT "ModerationFlag_coinMint_fkey" FOREIGN KEY ("coinMint") REFERENCES "Coin"("mint") ON DELETE RESTRICT ON UPDATE CASCADE;
