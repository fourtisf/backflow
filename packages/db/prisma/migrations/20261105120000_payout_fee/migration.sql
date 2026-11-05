-- Payout transaction fees are paid from the coin's holder budget (D-049).
ALTER TABLE "Payout" ADD COLUMN "feeLamports" BIGINT NOT NULL DEFAULT 0;
