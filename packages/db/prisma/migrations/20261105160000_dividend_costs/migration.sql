-- Every cost of moving holders' money is paid from the holders' share, not by the platform (D-053).
ALTER TABLE "VaultClaim" ADD COLUMN "feeLamports" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "VaultClaim" ADD COLUMN "feeCharged" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Harvest" ADD COLUMN "feeLamports" BIGINT NOT NULL DEFAULT 0;
