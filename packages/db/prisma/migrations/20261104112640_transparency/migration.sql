-- AlterTable
ALTER TABLE "Buyback" ADD COLUMN     "carriedIn" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Forfeiture" (
    "payoutId" TEXT NOT NULL,
    "coinMint" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Forfeiture_pkey" PRIMARY KEY ("payoutId","wallet")
);

-- CreateIndex
CREATE INDEX "Forfeiture_wallet_idx" ON "Forfeiture"("wallet");

-- AddForeignKey
ALTER TABLE "Forfeiture" ADD CONSTRAINT "Forfeiture_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
