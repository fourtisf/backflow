/**
 * Brand and copy values derived from config. UI copy that mentions a fee,
 * threshold or interval must use these so it always matches config/fees.json.
 */
import app from "../../../config/app.json";
import { BUYBACK, CURVE, FEES, PAYOUT, RATES } from "./fees";
import { everyInterval, ppmPct, solWhole } from "./format";
import { mulDivCeil } from "./math";

export const BRAND = app.brand;
export const COMPARE = {
  name: app.compare.name,
  curveFeePpm: BigInt(app.compare.curveFeePpm),
};
export const UI = app.ui;

/** Percent strings for copy, e.g. COPY.holders = "0.45%". */
export const COPY = {
  total: ppmPct(RATES.totalPpm),
  holders: ppmPct(RATES.holdersPpm),
  platform: ppmPct(RATES.platformSharePpm),
  platformFee: ppmPct(RATES.platformFeePpm),
  creator: ppmPct(RATES.creatorFeePpm),
  raydium: ppmPct(RATES.raydiumProtocolPpm),
  compareTotal: ppmPct(COMPARE.curveFeePpm),
  /** "1" (SOL) */
  buybackThresholdSol: solWhole(BUYBACK.thresholdLamports),
  /** "85" (SOL) */
  graduationSol: solWhole(CURVE.graduationTargetLamports),
  /** "1%" */
  maxImpact: ppmPct(BigInt(BUYBACK.maxImpactBps) * 100n),
  /** "5 minutes" */
  payoutEvery: everyInterval(PAYOUT.intervalSec),
  minPayoutUsd: PAYOUT.minPayoutUsd,
} as const;

export const META_DESCRIPTION = `Launch coins on Solana where ${COPY.holders} of every trade buys the coin back and pays it to holders.`;

/** Fee split segments in display order, with their ppm share of volume. */
export const FEE_SEGMENTS = [
  { key: "hold", label: "Holders", ppm: RATES.holdersPpm, pct: COPY.holders },
  { key: "plat", label: "Platform", ppm: RATES.platformSharePpm, pct: COPY.platform },
  { key: "crea", label: "Creator", ppm: RATES.creatorFeePpm, pct: COPY.creator },
  { key: "ray", label: "Raydium", ppm: RATES.raydiumProtocolPpm, pct: COPY.raydium },
] as const;

/** Example amounts for the "one trade, start to finish" diagram (a 1 SOL buy). */
export function exampleTrade(lamports: bigint = 1_000_000_000n) {
  return {
    amount: lamports,
    totalFee: mulDivCeil(lamports, RATES.totalPpm, 1_000_000n),
    holders: mulDivCeil(lamports, RATES.holdersPpm, 1_000_000n),
  };
}

export { FEES };
