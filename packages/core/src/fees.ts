/**
 * Canonical fee constants, loaded from config/fees.json.
 *
 * This is the only module that reads fee numbers. Everything else (UI copy,
 * workers, API) must import from here so a change to config/fees.json flows
 * through the whole product. Rates are parts per million (1_000_000 = 100%).
 */
import raw from "../../../config/fees.json";

export const PPM = 1_000_000n;

type RawFees = typeof raw;

function int(name: string, v: unknown): bigint {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`fees.json: ${name} must be an integer, got ${v}`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error(`fees.json: ${name} must be an integer or integer string, got ${String(v)}`);
}

function nonNeg(name: string, v: bigint): bigint {
  if (v < 0n) throw new Error(`fees.json: ${name} must be >= 0`);
  return v;
}

export interface FeeRates {
  /** Raydium protocol fee (GlobalConfig.trade_fee_rate). Set by Raydium, not us. */
  readonly raydiumProtocolPpm: bigint;
  /** Our LaunchLab platform fee (PlatformConfig.fee_rate). Split off-chain into holders + platform. */
  readonly platformFeePpm: bigint;
  /** LaunchLab native creator fee (PlatformConfig.creator_fee_rate). */
  readonly creatorFeePpm: bigint;
  /** Holders' (buyback) share of volume = platformFeePpm × holdersNumerator / holdersDenominator. */
  readonly holdersPpm: bigint;
  /** Platform's retained share of volume = platformFeePpm − holdersPpm. */
  readonly platformSharePpm: bigint;
  /** Total paid by the trader = raydium + platform fee + creator. */
  readonly totalPpm: bigint;
  /** The total we promise in copy. A mismatch with totalPpm throws at load time. */
  readonly totalTargetPpm: bigint;
}

export interface PlatformFeeSplit {
  readonly holdersNumerator: bigint;
  readonly holdersDenominator: bigint;
}

export interface CurveParams {
  readonly quoteMint: string;
  readonly curveType: number;
  /** Whole tokens (not base units). */
  readonly supplyTokens: bigint;
  readonly decimals: number;
  /** Total supply in base units = supplyTokens × 10^decimals. */
  readonly supplyBaseUnits: bigint;
  readonly sellOnCurvePpm: bigint;
  /** Base units sold on the curve = supplyBaseUnits × sellOnCurvePpm / 1e6. */
  readonly sellOnCurveBaseUnits: bigint;
  readonly graduationTargetLamports: bigint;
  readonly vestingLocked: bigint;
}

export interface BuybackParams {
  readonly thresholdLamports: bigint;
  readonly maxImpactBps: number;
  readonly minSpacingSec: number;
}

export interface PayoutParams {
  readonly intervalSec: number;
  readonly minPayoutUsd: number;
}

export interface MigrateLockScale {
  readonly platformScale: bigint;
  readonly creatorScale: bigint;
  readonly burnScale: bigint;
}

export interface PostGradHarvest {
  readonly solToBuybackNumerator: bigint;
  readonly solToBuybackDenominator: bigint;
  readonly coinTokensToHoldersPpm: bigint;
}

export interface FeeConfig {
  readonly rates: FeeRates;
  readonly platformFeeSplit: PlatformFeeSplit;
  readonly curve: CurveParams;
  readonly buyback: BuybackParams;
  readonly payout: PayoutParams;
  readonly migrateCpLockNftScale: MigrateLockScale;
  readonly postGradHarvest: PostGradHarvest;
}

/** Parse and validate a fees.json-shaped object. Exported for tests. */
export function parseFeeConfig(src: RawFees): FeeConfig {
  const r = src.ratesPpm;
  const raydiumProtocolPpm = nonNeg("ratesPpm.raydiumProtocol", int("ratesPpm.raydiumProtocol", r.raydiumProtocol));
  const platformFeePpm = nonNeg("ratesPpm.platformFeeRate", int("ratesPpm.platformFeeRate", r.platformFeeRate));
  const creatorFeePpm = nonNeg("ratesPpm.creatorFeeRate", int("ratesPpm.creatorFeeRate", r.creatorFeeRate));
  const totalTargetPpm = int("ratesPpm.totalTarget", r.totalTarget);

  const num = int("platformFeeSplit.holdersNumerator", src.platformFeeSplit.holdersNumerator);
  const den = int("platformFeeSplit.holdersDenominator", src.platformFeeSplit.holdersDenominator);
  if (den <= 0n || num < 0n || num > den) throw new Error("fees.json: platformFeeSplit must satisfy 0 <= num <= den, den > 0");

  // The holders' share of *volume* must be an exact ppm value, otherwise the
  // copy ("0.45%") and the math would disagree.
  if ((platformFeePpm * num) % den !== 0n) {
    throw new Error("fees.json: platformFeeRate × holdersNumerator must divide evenly by holdersDenominator");
  }
  const holdersPpm = (platformFeePpm * num) / den;
  const platformSharePpm = platformFeePpm - holdersPpm;
  const totalPpm = raydiumProtocolPpm + platformFeePpm + creatorFeePpm;
  if (totalPpm !== totalTargetPpm) {
    throw new Error(`fees.json: raydium + platform + creator = ${totalPpm} ppm, but totalTarget is ${totalTargetPpm} ppm`);
  }

  const c = src.curve;
  const decimals = c.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("fees.json: curve.decimals out of range");
  const supplyTokens = int("curve.supply", c.supply);
  const supplyBaseUnits = supplyTokens * 10n ** BigInt(decimals);
  const sellOnCurvePpm = int("curve.sellOnCurvePpm", c.sellOnCurvePpm);
  if (sellOnCurvePpm <= 0n || sellOnCurvePpm > PPM) throw new Error("fees.json: curve.sellOnCurvePpm out of range");

  const s = src.graduation.migrateCpLockNftScale;
  const scale: MigrateLockScale = {
    platformScale: int("platformScale", s.platformScale),
    creatorScale: int("creatorScale", s.creatorScale),
    burnScale: int("burnScale", s.burnScale),
  };
  if (scale.platformScale + scale.creatorScale + scale.burnScale !== PPM) {
    throw new Error("fees.json: migrateCpLockNftScale must sum to 1_000_000");
  }

  const h = src.graduation.postGradHarvest;
  const postGradHarvest: PostGradHarvest = {
    solToBuybackNumerator: int("solToBuybackNumerator", h.solToBuybackNumerator),
    solToBuybackDenominator: int("solToBuybackDenominator", h.solToBuybackDenominator),
    coinTokensToHoldersPpm: int("coinTokensToHoldersPpm", h.coinTokensToHoldersPpm),
  };
  if (postGradHarvest.solToBuybackDenominator <= 0n) throw new Error("fees.json: solToBuybackDenominator must be > 0");

  return {
    rates: { raydiumProtocolPpm, platformFeePpm, creatorFeePpm, holdersPpm, platformSharePpm, totalPpm, totalTargetPpm },
    platformFeeSplit: { holdersNumerator: num, holdersDenominator: den },
    curve: {
      quoteMint: c.quoteMint,
      curveType: c.curveType,
      supplyTokens,
      decimals,
      supplyBaseUnits,
      sellOnCurvePpm,
      sellOnCurveBaseUnits: (supplyBaseUnits * sellOnCurvePpm) / PPM,
      graduationTargetLamports: int("curve.graduationTargetLamports", c.graduationTargetLamports),
      vestingLocked: int("curve.vestingLocked", c.vestingLocked),
    },
    buyback: {
      thresholdLamports: int("buyback.thresholdLamports", src.buyback.thresholdLamports),
      maxImpactBps: src.buyback.maxImpactBps,
      minSpacingSec: src.buyback.minSpacingSec,
    },
    payout: { intervalSec: src.payout.intervalSec, minPayoutUsd: src.payout.minPayoutUsd },
    migrateCpLockNftScale: scale,
    postGradHarvest,
  };
}

/** The live fee config. Throws at import time if config/fees.json is inconsistent. */
export const FEES: FeeConfig = parseFeeConfig(raw);
export const RATES = FEES.rates;
export const CURVE = FEES.curve;
export const BUYBACK = FEES.buyback;
export const PAYOUT = FEES.payout;

/** Number of decimals for SOL / wSOL. Fixed by the protocol. */
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
