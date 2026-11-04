-- AlterTable
ALTER TABLE "Buyback" ADD COLUMN     "credited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastValidBlockHeight" BIGINT,
ADD COLUMN     "slot" BIGINT;

-- AlterTable
ALTER TABLE "Coin" ADD COLUMN     "buybackRound" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extraRewardTokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "lastBuybackAt" TIMESTAMP(3),
ADD COLUMN     "lastDistributionAt" TIMESTAMP(3),
ADD COLUMN     "roundRemainingLamports" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Harvest" ADD COLUMN     "feeKeyNftMint" TEXT,
ADD COLUMN     "lastValidBlockHeight" BIGINT,
ADD COLUMN     "settleLastValidBlockHeight" BIGINT,
ADD COLUMN     "settleSignature" TEXT,
ADD COLUMN     "settled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PayoutItem" ADD COLUMN     "lastValidBlockHeight" BIGINT;

-- AlterTable
ALTER TABLE "VaultClaim" ADD COLUMN     "lastValidBlockHeight" BIGINT,
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'claim',
ADD COLUMN     "transferLastValidBlockHeight" BIGINT;
