/**
 * Integer money math. Every on-chain amount is a bigint in base units
 * (lamports for SOL, token base units for coins). No floats here.
 */
import { FEES, PPM, type FeeRates, type PlatformFeeSplit } from "./fees";

export type Rounding = "floor" | "ceil";

function assertNonNeg(name: string, v: bigint): void {
  if (v < 0n) throw new RangeError(`${name} must be >= 0, got ${v}`);
}

/** floor(a × num / den) for non-negative inputs. */
/** Negative amounts shown as 0 (a coin's holder budget can be briefly negative after payout fees, D-049). */
export const atLeastZero = (v: bigint): bigint => (v > 0n ? v : 0n);

export function mulDivFloor(a: bigint, num: bigint, den: bigint): bigint {
  assertNonNeg("a", a);
  assertNonNeg("num", num);
  if (den <= 0n) throw new RangeError("den must be > 0");
  return (a * num) / den;
}

/** ceil(a × num / den) for non-negative inputs. */
export function mulDivCeil(a: bigint, num: bigint, den: bigint): bigint {
  assertNonNeg("a", a);
  assertNonNeg("num", num);
  if (den <= 0n) throw new RangeError("den must be > 0");
  const p = a * num;
  return p === 0n ? 0n : (p - 1n) / den + 1n;
}

/** Fee of `ratePpm` on `amount`, rounded as the program rounds. */
export function feeOn(amount: bigint, ratePpm: bigint, rounding: Rounding): bigint {
  return rounding === "ceil" ? mulDivCeil(amount, ratePpm, PPM) : mulDivFloor(amount, ratePpm, PPM);
}

export interface PlatformFeeParts {
  /** Credited to the coin's buyback budget. floor(fee × num / den). */
  readonly holders: bigint;
  /** Kept by the platform. fee − holders, so rounding dust goes to the platform. */
  readonly platform: bigint;
}

/**
 * Split one platform-fee amount (lamports) into holders' and platform's parts.
 * SPEC §2.1: holders = floor(fee × 2 / 3); platform = fee − holders.
 */
export function splitPlatformFee(platformFee: bigint, split: PlatformFeeSplit = FEES.platformFeeSplit): PlatformFeeParts {
  assertNonNeg("platformFee", platformFee);
  const holders = mulDivFloor(platformFee, split.holdersNumerator, split.holdersDenominator);
  return { holders, platform: platformFee - holders };
}

export interface TradeFees {
  /** Raydium protocol fee. */
  readonly protocol: bigint;
  /** Our platform fee (lands in the shared platform fee vault). */
  readonly platform: bigint;
  /** Creator fee (lands in the creator's fee vault). */
  readonly creator: bigint;
  /** Referral share fee. Backflow never sets one, so this is 0. */
  readonly share: bigint;
  /** protocol + platform + creator + share. */
  readonly total: bigint;
  /** platform split: holders' buyback budget. */
  readonly holdersPart: bigint;
  /** platform split: platform's retained revenue. */
  readonly platformPart: bigint;
}

/**
 * Fees LaunchLab charges on a bonding-curve trade whose quote (SOL) side is
 * `quoteAmount` lamports: the SOL paid in on a buy, or the gross SOL out on a
 * sell. Mirrors the SDK (`src/raydium/launchpad/curve/curve.ts`, calculateFee +
 * splitFee; see docs/DECISIONS.md D-003):
 *
 *   total    = ceil(quote × (protocol + platform + share + creator) / 1e6)
 *   platform = floor(total × platformRate / totalRate)
 *   creator  = floor(total × creatorRate  / totalRate)
 *   share    = floor(total × shareRate    / totalRate)
 *   protocol = total − platform − creator − share   (protocol gets the dust)
 *
 * The indexer prefers the exact fees from the program's TradeEvent; this is
 * for quotes and for recomputing when the event is unavailable.
 */
export function tradeFees(quoteAmount: bigint, rates: FeeRates = FEES.rates, shareFeePpm: bigint = 0n): TradeFees {
  assertNonNeg("quoteAmount", quoteAmount);
  const totalRate = totalFeeRate(rates, shareFeePpm);
  return splitTotalFee(mulDivCeil(quoteAmount, totalRate, PPM), rates, shareFeePpm);
}

/** protocol + platform + creator + share, in ppm. Throws above 100%. */
export function totalFeeRate(rates: FeeRates = FEES.rates, shareFeePpm: bigint = 0n): bigint {
  assertNonNeg("shareFeePpm", shareFeePpm);
  const totalRate = rates.raydiumProtocolPpm + rates.platformFeePpm + rates.creatorFeePpm + shareFeePpm;
  if (totalRate > PPM) throw new RangeError("total fee rate exceeds 100%");
  return totalRate;
}

/** Split an already-computed total fee the way LaunchLab's splitFee does. */
export function splitTotalFee(total: bigint, rates: FeeRates = FEES.rates, shareFeePpm: bigint = 0n): TradeFees {
  assertNonNeg("total", total);
  const totalRate = totalFeeRate(rates, shareFeePpm);
  const part = (rate: bigint) => (totalRate === 0n ? 0n : mulDivFloor(total, rate, totalRate));
  const platform = part(rates.platformFeePpm);
  const creator = part(rates.creatorFeePpm);
  const share = part(shareFeePpm);
  const protocol = total - platform - creator - share;
  const { holders, platform: platformPart } = splitPlatformFee(platform);
  return { protocol, platform, creator, share, total, holdersPart: holders, platformPart };
}

/** Price scale for `estimateBuy` / `estimateSell`: lamports per whole token × 1e9. */
export const PRICE_SCALE = 1_000_000_000n;

export interface BuyEstimate {
  readonly fees: TradeFees;
  /** SOL that reaches the curve after fees. */
  readonly net: bigint;
  /** Token base units out. */
  readonly tokensOut: bigint;
}

/**
 * Spot-price estimate of a buy: fees on the SOL in, then net SOL / price.
 * For display before Milestone 4 adds the exact curve quote.
 * @param priceScaled lamports per whole token × PRICE_SCALE
 */
export function estimateBuy(quoteIn: bigint, priceScaled: bigint, decimals: number, rates: FeeRates = FEES.rates): BuyEstimate {
  const fees = tradeFees(quoteIn, rates);
  const net = quoteIn - fees.total;
  const tokensOut = priceScaled > 0n ? mulDivFloor(net, 10n ** BigInt(decimals) * PRICE_SCALE, priceScaled) : 0n;
  return { fees, net, tokensOut };
}

export interface SellEstimate {
  readonly fees: TradeFees;
  /** SOL out before fees. */
  readonly gross: bigint;
  /** SOL to the seller after fees. */
  readonly out: bigint;
}

/** Spot-price estimate of a sell: tokens × price, then fees on the SOL out. */
export function estimateSell(tokensIn: bigint, priceScaled: bigint, decimals: number, rates: FeeRates = FEES.rates): SellEstimate {
  const gross = mulDivFloor(tokensIn, priceScaled, 10n ** BigInt(decimals) * PRICE_SCALE);
  const fees = tradeFees(gross, rates);
  return { fees, gross, out: gross - fees.total };
}

/** Parse a decimal string ("1.5", "0.000000001") into base units. Returns null when invalid or too precise. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/,/g, ".");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Base units → exact decimal string, trailing zeros trimmed ("1.5", "0.0045"). */
export function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/**
 * Lossy conversion of base units to a JS number, for display and charting only.
 * Never feed the result back into money math.
 */
export function toDisplayNumber(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

/** Ratio as parts per million, floored. Returns 0 when den is 0. */
export function ratioPpm(num: bigint, den: bigint): bigint {
  if (den <= 0n) return 0n;
  return mulDivFloor(num < 0n ? 0n : num, PPM, den);
}

/** min(a, b) for bigints. */
export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** max(a, b) for bigints. */
export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
