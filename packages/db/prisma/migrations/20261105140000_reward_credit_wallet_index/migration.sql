-- Wallet history reads RewardCredit by wallet alone (audit).
CREATE INDEX "RewardCredit_wallet_idx" ON "RewardCredit"("wallet");
