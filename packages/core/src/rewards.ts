/**
 * Holder rewards math (SPEC §3.2–3.3, §2.2, §6.3). Pure bigint, deterministic,
 * so every credit and payout can be reproduced from stored inputs.
 */
import { FEES, PPM } from "./fees";
import { mulDivFloor } from "./math";

/* ---------------------------------- TWAB ---------------------------------- */

/** A balance change: the wallet's balance AFTER the change, at unix second `t`. */
export interface BalancePoint {
  t: number;
  balance: bigint;
}

export interface HolderHistory {
  /** Balance at the start of the window. */
  startBalance: bigint;
  /** Changes inside the window, any order. Points outside [start, end) are ignored. */
  points: BalancePoint[];
}

/**
 * Time-weighted balance integral Σ balance × seconds over [start, end).
 * TWAB = weight / (end − start); since every wallet shares the window, shares
 * can be computed from the integrals directly.
 */
export function twabWeight(h: HolderHistory, start: number, end: number): bigint {
  if (end <= start) return 0n;
  const pts = h.points.filter((p) => p.t >= start && p.t < end).sort((a, b) => a.t - b.t);
  let w = 0n;
  let bal = h.startBalance;
  let t = start;
  for (const p of pts) {
    if (bal > 0n) w += bal * BigInt(p.t - t);
    bal = p.balance;
    t = p.t;
  }
  if (bal > 0n) w += bal * BigInt(end - t);
  return w;
}

/** Weights for every eligible wallet; excluded wallets and zero weights are dropped. */
export function twabWeights(histories: Map<string, HolderHistory>, start: number, end: number, excluded: ReadonlySet<string>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const [wallet, h] of histories) {
    if (excluded.has(wallet)) continue;
    const w = twabWeight(h, start, end);
    if (w > 0n) out.set(wallet, w);
  }
  return out;
}

/* ------------------------------ distribution ------------------------------ */

export interface Distribution {
  credits: Map<string, bigint>;
  /** Tokens not credited due to integer division; carried to the next distribution. */
  dust: bigint;
}

/**
 * Split `total` tokens pro rata by weight: credit = floor(total × w / Σw).
 * Σ credits + dust = total, and dust < number of recipients. Order-independent.
 */
export function distribute(total: bigint, weights: Map<string, bigint>): Distribution {
  if (total < 0n) throw new RangeError("total must be >= 0");
  let sum = 0n;
  for (const w of weights.values()) {
    if (w < 0n) throw new RangeError("weights must be >= 0");
    sum += w;
  }
  const credits = new Map<string, bigint>();
  if (sum === 0n || total === 0n) return { credits, dust: total };
  let given = 0n;
  for (const [wallet, w] of [...weights.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const c = mulDivFloor(total, w, sum);
    if (c > 0n) credits.set(wallet, c);
    given += c;
  }
  return { credits, dust: total - given };
}

/* ------------------------------- forfeiture -------------------------------- */

/** SPEC §3.3: any decrease (sell, transfer out, partial sell) since the last payout forfeits pending. */
export function decreasedSince(deltas: bigint[]): boolean {
  return deltas.some((d) => d < 0n);
}

/* --------------------------------- payouts --------------------------------- */

export interface PendingEntry {
  wallet: string;
  amount: bigint;
  /** True if the wallet's balance decreased since the coin's previous payout. */
  decreased: boolean;
}

export interface PayoutPlan {
  pay: { wallet: string; amount: bigint }[];
  /** Below the minimum payout; stays pending. */
  rollover: { wallet: string; amount: bigint }[];
  /** Forfeited pending, returned to the coin's next distribution. */
  forfeited: bigint;
  forfeitedWallets: string[];
  /** Per-wallet forfeitures (for the public history). */
  forfeits: { wallet: string; amount: bigint }[];
  total: bigint;
}

/**
 * Decide what to pay this round for one coin.
 * @param minTokens minimum payout in token base units (from MIN_PAYOUT_USD at the current price); 0n pays everything.
 */
export function planPayout(entries: PendingEntry[], minTokens: bigint): PayoutPlan {
  const plan: PayoutPlan = { pay: [], rollover: [], forfeited: 0n, forfeitedWallets: [], forfeits: [], total: 0n };
  for (const e of [...entries].sort((a, b) => (a.wallet < b.wallet ? -1 : 1))) {
    if (e.amount <= 0n) continue;
    if (e.decreased) {
      plan.forfeited += e.amount;
      plan.forfeitedWallets.push(e.wallet);
      plan.forfeits.push({ wallet: e.wallet, amount: e.amount });
    } else if (e.amount < minTokens) plan.rollover.push({ wallet: e.wallet, amount: e.amount });
    else {
      plan.pay.push({ wallet: e.wallet, amount: e.amount });
      plan.total += e.amount;
    }
  }
  return plan;
}

/**
 * Minimum payout in token base units: ceil(minUsd / priceUsdPerToken × 10^decimals).
 * A threshold, not an amount sent, so the float price is acceptable here.
 * Returns null when the price is unknown (then nothing is paid; it all rolls over).
 */
export function minPayoutTokens(priceUsdPerToken: number | null, decimals: number = FEES.curve.decimals, minUsd: number = FEES.payout.minPayoutUsd): bigint | null {
  if (minUsd <= 0) return 0n;
  if (priceUsdPerToken == null || !(priceUsdPerToken > 0) || !Number.isFinite(priceUsdPerToken)) return null;
  const units = Math.ceil((minUsd / priceUsdPerToken) * 10 ** decimals);
  return Number.isFinite(units) ? BigInt(units) : null;
}

/** Split a list into batches of at most `size`. */
export function batches<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("batch size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* --------------------------------- buybacks -------------------------------- */

export interface BuybackRoundInput {
  /** Lamports credited to the coin and not yet spent. */
  budget: bigint;
  /** Lamports still to spend in the current round (0 = no round open). */
  roundRemaining: bigint;
  /** Largest chunk the impact cap allows right now. */
  maxChunk: bigint;
  /** Seconds since the last chunk of this coin. */
  secondsSinceLastChunk: number;
  threshold?: bigint;
  minSpacingSec?: number;
}

export interface BuybackStep {
  action: "wait" | "open_round" | "buy";
  /** Lamports to spend in this chunk (when action = buy). */
  amount: bigint;
  /** Round size, when a new round opens. */
  roundSize: bigint;
  reason: string;
}

/**
 * SPEC §3.1: a round of `threshold` lamports opens when budget ≥ threshold; it is
 * spent in chunks no larger than the impact cap allows, at least `minSpacingSec` apart.
 */
export function nextBuybackStep(i: BuybackRoundInput): BuybackStep {
  const threshold = i.threshold ?? FEES.buyback.thresholdLamports;
  const spacing = i.minSpacingSec ?? FEES.buyback.minSpacingSec;
  if (i.roundRemaining <= 0n) {
    if (i.budget >= threshold) return { action: "open_round", amount: 0n, roundSize: threshold, reason: "budget reached threshold" };
    return { action: "wait", amount: 0n, roundSize: 0n, reason: "budget below threshold" };
  }
  if (i.secondsSinceLastChunk < spacing) return { action: "wait", amount: 0n, roundSize: 0n, reason: "spacing" };
  const spendable = i.roundRemaining < i.budget ? i.roundRemaining : i.budget;
  const amount = spendable < i.maxChunk ? spendable : i.maxChunk;
  if (amount <= 0n) return { action: "wait", amount: 0n, roundSize: 0n, reason: "impact cap allows nothing now" };
  return { action: "buy", amount, roundSize: 0n, reason: amount < spendable ? "chunk limited by impact cap" : "final chunk" };
}

/* ------------------------------- reconciliation ---------------------------- */

export interface ReconcileResult {
  ok: boolean;
  diff: bigint;
  /** |claimed − expected| / expected in ppm (claimed > 0 with expected 0 counts as 1e6). */
  mismatchPpm: bigint;
}

/** SPEC §6.3: claimed lamports must match Σ accrued platform fees within 0.5%. */
export function reconcile(claimed: bigint, expected: bigint, tolerancePpm = 5_000n): ReconcileResult {
  const diff = claimed - expected;
  const abs = diff < 0n ? -diff : diff;
  const mismatchPpm = expected === 0n ? (claimed === 0n ? 0n : PPM) : (abs * PPM) / expected;
  return { ok: mismatchPpm <= tolerancePpm, diff, mismatchPpm };
}

/* -------------------------------- harvests --------------------------------- */

/** SPEC §2.2: harvested SOL is 2/3 buyback, 1/3 platform (rounding to the platform); coin tokens per ppm to holders. */
export function splitHarvest(sol: bigint, tokens: bigint, h = FEES.postGradHarvest): { solToBuyback: bigint; solToPlatform: bigint; tokensToHolders: bigint; tokensToPlatform: bigint } {
  const solToBuyback = mulDivFloor(sol, h.solToBuybackNumerator, h.solToBuybackDenominator);
  const tokensToHolders = mulDivFloor(tokens, h.coinTokensToHoldersPpm, PPM);
  return { solToBuyback, solToPlatform: sol - solToBuyback, tokensToHolders, tokensToPlatform: tokens - tokensToHolders };
}

/* --------------------------------- candles --------------------------------- */

export const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 } as const;

/** Candle open time (unix seconds) for a timestamp. */
export function candleOpen(tSec: number, tfSec: number): number {
  return Math.floor(tSec / tfSec) * tfSec;
}
