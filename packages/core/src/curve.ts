/**
 * LaunchLab constant-product bonding curve, ported from the SDK
 * (src/raydium/launchpad/curve/constantProductCurve.ts and curve.ts,
 * @raydium-io/raydium-sdk-v2 0.2.81-alpha). Pure bigint; SPL Token only
 * (no Token-2022 transfer fees). Base = the coin, quote = SOL.
 *
 *   price (lamports per base unit) = (virtualQuote + realQuote) / (virtualBase − realBase)
 *   buy:  out = floor(netIn × (vB − rB) / (vQ + rQ + netIn))
 *   sell: out = floor(in × (vQ + rQ) / (vB − rB + in))
 */
import { FEES, PPM, type FeeRates } from "./fees";
import { mulDivCeil, mulDivFloor, splitTotalFee, totalFeeRate, type TradeFees } from "./math";

export interface CurveState {
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  /** Base units the curve sells before it completes. */
  totalSellBase: bigint;
}

/** Virtual reserves at launch (SDK getInitParam). */
export function curveInit(p: { supply: bigint; totalSell: bigint; totalFundRaising: bigint; totalLocked: bigint; migrateFee: bigint }): {
  virtualBase: bigint;
  virtualQuote: bigint;
} {
  if (p.supply <= p.totalSell) throw new RangeError("supply must be greater than total sell");
  const supplyMinusSellLocked = p.supply - p.totalSell - p.totalLocked;
  if (supplyMinusSellLocked <= 0n) throw new RangeError("supply − sell − locked must be > 0");
  const tfMinusMf = p.totalFundRaising - p.migrateFee;
  if (tfMinusMf <= 0n) throw new RangeError("fund raising must exceed the migrate fee");
  const numerator = (tfMinusMf * p.totalSell * p.totalSell) / supplyMinusSellLocked;
  const denominator = (tfMinusMf * p.totalSell) / supplyMinusSellLocked - p.totalFundRaising;
  if (denominator <= 0n) throw new RangeError("invalid curve parameters");
  const x0 = numerator / denominator;
  const y0 = (p.totalFundRaising * p.totalFundRaising) / denominator;
  return { virtualBase: x0, virtualQuote: y0 };
}

export function newCurve(init: { virtualBase: bigint; virtualQuote: bigint }, totalSellBase: bigint): CurveState {
  return { ...init, realBase: 0n, realQuote: 0n, totalSellBase };
}

const quoteReserve = (s: CurveState) => s.virtualQuote + s.realQuote;
const baseReserve = (s: CurveState) => s.virtualBase - s.realBase;

/** Spot price as a fraction: lamports per base unit = num / den. */
export function spotPrice(s: CurveState): { num: bigint; den: bigint } {
  return { num: quoteReserve(s), den: baseReserve(s) };
}

/** Lamports per WHOLE token, as a decimal string with 9 fraction digits (for display / DTOs). */
export function priceLamportsPerToken(s: CurveState, decimals: number = FEES.curve.decimals): string {
  const { num, den } = spotPrice(s);
  if (den <= 0n) return "0";
  const scaled = (num * 10n ** BigInt(decimals) * 1_000_000_000n) / den; // × 1e9 for 9 fraction digits
  const w = scaled / 1_000_000_000n;
  const f = (scaled % 1_000_000_000n).toString().padStart(9, "0");
  return `${w}.${f}`;
}

/** Remaining base units the curve can still sell. */
export function remainingBase(s: CurveState): bigint {
  const r = s.totalSellBase - s.realBase;
  return r > 0n ? r : 0n;
}

export interface BuyQuote {
  /** Lamports the buyer actually pays (≤ requested when the curve completes). */
  amountIn: bigint;
  /** Lamports that reach the curve after fees. */
  netIn: bigint;
  /** Base units out. */
  amountOut: bigint;
  fees: TradeFees;
  /** True when the buy was capped by the curve's remaining supply (graduation buy). */
  completesCurve: boolean;
}

/** SDK Curve.buyExactIn for the constant-product curve. */
export function quoteBuy(s: CurveState, amountIn: bigint, rates: FeeRates = FEES.rates, shareFeePpm = 0n): BuyQuote {
  if (amountIn < 0n) throw new RangeError("amountIn must be >= 0");
  const rate = totalFeeRate(rates, shareFeePpm);
  const total = mulDivCeil(amountIn, rate, PPM);
  const net = amountIn - total;
  const out = (net * baseReserve(s)) / (quoteReserve(s) + net);
  const remaining = remainingBase(s);
  if (out > remaining) {
    // Graduation buy: take only what is left; recompute the SOL needed (ceil), then gross it up for fees.
    const amountOut = remaining;
    const netNeeded = amountOut === 0n ? 0n : ceilDiv(quoteReserve(s) * amountOut, baseReserve(s) - amountOut);
    const gross = rate >= PPM ? netNeeded : ceilDiv(netNeeded * PPM, PPM - rate);
    return { amountIn: gross, netIn: netNeeded, amountOut, fees: splitTotalFee(gross - netNeeded, rates, shareFeePpm), completesCurve: true };
  }
  return { amountIn, netIn: net, amountOut: out, fees: splitTotalFee(total, rates, shareFeePpm), completesCurve: out === remaining && remaining > 0n };
}

export interface SellQuote {
  amountIn: bigint;
  /** Lamports out of the curve before fees. */
  grossOut: bigint;
  /** Lamports to the seller. */
  amountOut: bigint;
  fees: TradeFees;
}

/** SDK Curve.sellExactIn for the constant-product curve. */
export function quoteSell(s: CurveState, amountIn: bigint, rates: FeeRates = FEES.rates, shareFeePpm = 0n): SellQuote {
  if (amountIn < 0n) throw new RangeError("amountIn must be >= 0");
  const gross = (amountIn * quoteReserve(s)) / (baseReserve(s) + amountIn);
  const total = mulDivCeil(gross, totalFeeRate(rates, shareFeePpm), PPM);
  return { amountIn, grossOut: gross, amountOut: gross - total, fees: splitTotalFee(total, rates, shareFeePpm) };
}

export function applyBuy(s: CurveState, q: BuyQuote): CurveState {
  return { ...s, realBase: s.realBase + q.amountOut, realQuote: s.realQuote + q.netIn };
}

export function applySell(s: CurveState, q: SellQuote): CurveState {
  return { ...s, realBase: s.realBase - q.amountIn, realQuote: s.realQuote - q.grossOut };
}

/** Price change from `a` to `b` in ppm (positive = price went up). */
export function priceChangePpm(a: { num: bigint; den: bigint }, b: { num: bigint; den: bigint }): bigint {
  // (b/a − 1) × 1e6 = (b.num·a.den − a.num·b.den) × 1e6 / (a.num·b.den)
  const base = a.num * b.den;
  if (base === 0n) return 0n;
  return ((b.num * a.den - base) * PPM) / base;
}

/** Price impact of a buy of `amountIn` lamports, in ppm. */
export function buyImpactPpm(s: CurveState, amountIn: bigint, rates: FeeRates = FEES.rates): bigint {
  const q = quoteBuy(s, amountIn, rates);
  return priceChangePpm(spotPrice(s), spotPrice(applyBuy(s, q)));
}

/**
 * Largest buy (gross lamports, ≤ `budget`) whose price impact stays within
 * `capBps`. Binary search on the exact quote, so it matches what the program
 * will do. Returns 0 if even 1 lamport would exceed the cap.
 */
export function maxBuyWithinImpact(s: CurveState, budget: bigint, capBps: number, rates: FeeRates = FEES.rates): bigint {
  const cap = BigInt(capBps) * 100n; // bps → ppm
  if (budget <= 0n) return 0n;
  if (buyImpactPpm(s, budget, rates) <= cap) return budget;
  let lo = 0n;
  let hi = budget;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (buyImpactPpm(s, mid, rates) <= cap) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Minimum base units out for a quote with slippage (bps), floored. */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) throw new RangeError("slippage must be 0–10000 bps");
  return mulDivFloor(amountOut, BigInt(10_000 - slippageBps), 10_000n);
}

/** Market cap in USD (display number): spot price × supply × SOL/USD. */
export function curveMcapUsd(s: CurveState, supplyBaseUnits: bigint, solUsd: number | null): number | null {
  if (solUsd == null) return null;
  const { num, den } = spotPrice(s);
  if (den <= 0n) return null;
  const lamports = (num * supplyBaseUnits) / den;
  return (Number(lamports) / 1e9) * solUsd;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("division by zero");
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/* --------------------------------- CPMM ---------------------------------- */

export interface CpmmPoolState {
  /** Coin (base) reserve available for swaps, base units. */
  reserveBase: bigint;
  /** SOL (quote) reserve available for swaps, lamports. */
  reserveQuote: bigint;
  /** AmmConfig trade fee, ppm. */
  tradeFeePpm: bigint;
  /** Pool creator fee, ppm, charged on top when it applies to the input (SOL). */
  creatorFeePpm: bigint;
  /** Whether the creator fee is taken from the SOL input on a buy. */
  creatorFeeOnQuoteInput: boolean;
}

/**
 * CPMM swap SOL → coin, base-in, mirroring SDK CurveCalculator.swapBaseInput:
 * tradeFee = ceil(in × tradeFeeRate / 1e6). If the creator fee is on the input,
 * creatorFee = ceil(in × creatorRate / 1e6) and comes off the input; otherwise it
 * comes off the output. out = floor(inLessFees × reserveOut / (reserveIn + inLessFees)).
 */
export function quoteCpmmBuy(p: CpmmPoolState, amountIn: bigint): { amountOut: bigint; tradeFee: bigint; creatorFee: bigint; inLessFees: bigint } {
  if (p.tradeFeePpm >= PPM || p.creatorFeePpm >= PPM) throw new RangeError("fee rate must be < 100%");
  const tradeFee = mulDivCeil(amountIn, p.tradeFeePpm, PPM);
  let creatorFee = p.creatorFeeOnQuoteInput ? mulDivCeil(amountIn, p.creatorFeePpm, PPM) : 0n;
  const inLessFees = amountIn - tradeFee - creatorFee;
  if (inLessFees <= 0n) return { amountOut: 0n, tradeFee, creatorFee, inLessFees: 0n };
  const swapped = (inLessFees * p.reserveBase) / (p.reserveQuote + inLessFees);
  if (p.creatorFeeOnQuoteInput) return { amountOut: swapped, tradeFee, creatorFee, inLessFees };
  creatorFee = mulDivCeil(swapped, p.creatorFeePpm, PPM);
  return { amountOut: swapped - creatorFee, tradeFee, creatorFee, inLessFees };
}

export function cpmmBuyImpactPpm(p: CpmmPoolState, amountIn: bigint): bigint {
  const q = quoteCpmmBuy(p, amountIn);
  const before = { num: p.reserveQuote, den: p.reserveBase };
  // Conservative: count the whole trade fee as staying in the pool (only the LP share does),
  // which overstates the post-trade price slightly, so the cap is never exceeded.
  const sentToPool = p.creatorFeeOnQuoteInput ? amountIn - q.creatorFee : amountIn;
  const after = { num: p.reserveQuote + sentToPool, den: p.reserveBase - (q.amountOut + (p.creatorFeeOnQuoteInput ? 0n : q.creatorFee)) };
  return priceChangePpm(before, after);
}

export function maxCpmmBuyWithinImpact(p: CpmmPoolState, budget: bigint, capBps: number): bigint {
  const cap = BigInt(capBps) * 100n;
  if (budget <= 0n) return 0n;
  if (cpmmBuyImpactPpm(p, budget) <= cap) return budget;
  let lo = 0n;
  let hi = budget;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (cpmmBuyImpactPpm(p, mid) <= cap) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}
