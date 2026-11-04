import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyBuy,
  applySell,
  buyImpactPpm,
  cpmmBuyImpactPpm,
  curveInit,
  maxBuyWithinImpact,
  maxCpmmBuyWithinImpact,
  minOutWithSlippage,
  newCurve,
  priceLamportsPerToken,
  quoteBuy,
  quoteCpmmBuy,
  quoteCpmmSell,
  cpmmSellImpactPpm,
  quoteSell,
  remainingBase,
  spotPrice,
  type CpmmPoolState,
  type CurveState,
} from "../src/curve";
import { CURVE } from "../src/fees";

const SOL = 1_000_000_000n;
// Backflow's launch parameters from config/fees.json, migrate fee assumed 0 here.
const init = curveInit({ supply: CURVE.supplyBaseUnits, totalSell: CURVE.sellOnCurveBaseUnits, totalFundRaising: CURVE.graduationTargetLamports, totalLocked: 0n, migrateFee: 0n });
const fresh: CurveState = newCurve(init, CURVE.sellOnCurveBaseUnits);

describe("curveInit", () => {
  it("produces positive virtual reserves", () => {
    expect(init.virtualBase).toBeGreaterThan(CURVE.sellOnCurveBaseUnits);
    expect(init.virtualQuote).toBeGreaterThan(0n);
  });
  it("selling the whole curve raises about the graduation target", () => {
    // Buying exactly totalSell needs ≈ totalFundRaising of net SOL.
    const q = quoteBuy(fresh, 10_000n * SOL);
    expect(q.completesCurve).toBe(true);
    expect(q.amountOut).toBe(CURVE.sellOnCurveBaseUnits);
    const diff = q.netIn - CURVE.graduationTargetLamports;
    expect(diff < 0n ? -diff : diff).toBeLessThan(SOL / 1000n); // within 0.001 SOL
  });
  it("rejects impossible parameters", () => {
    expect(() => curveInit({ supply: 10n, totalSell: 10n, totalFundRaising: 1n, totalLocked: 0n, migrateFee: 0n })).toThrow();
  });
});

describe("quotes", () => {
  it("buy: fees come off the SOL in and reserves move", () => {
    const q = quoteBuy(fresh, SOL);
    expect(q.fees.total).toBe(11_000_000n);
    expect(q.netIn).toBe(SOL - 11_000_000n);
    expect(q.amountOut).toBeGreaterThan(0n);
    const s2 = applyBuy(fresh, q);
    expect(s2.realBase).toBe(q.amountOut);
    expect(s2.realQuote).toBe(q.netIn);
  });

  it("sell right after buy returns less than paid (round trip loses at least the fees)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1_000_000n, max: 50n * SOL }), (amt) => {
        const b = quoteBuy(fresh, amt);
        const s2 = applyBuy(fresh, b);
        const sq = quoteSell(s2, b.amountOut);
        return sq.amountOut < b.amountIn && sq.grossOut <= b.netIn;
      }),
      { numRuns: 200 },
    );
  });

  it("price only rises on buys and falls on sells", () => {
    const p0 = spotPrice(fresh);
    const b = quoteBuy(fresh, 3n * SOL);
    const s1 = applyBuy(fresh, b);
    const p1 = spotPrice(s1);
    expect(p1.num * p0.den).toBeGreaterThan(p0.num * p1.den);
    const s2 = applySell(s1, quoteSell(s1, b.amountOut / 2n));
    const p2 = spotPrice(s2);
    expect(p2.num * p1.den).toBeLessThan(p1.num * p2.den);
  });

  it("caps the graduation buy at the remaining supply", () => {
    const nearlyDone: CurveState = { ...fresh, realBase: CURVE.sellOnCurveBaseUnits - 1000n, realQuote: 84n * SOL };
    const q = quoteBuy(nearlyDone, 5n * SOL);
    expect(q.completesCurve).toBe(true);
    expect(q.amountOut).toBe(1000n);
    expect(q.amountIn).toBeLessThan(5n * SOL);
    expect(remainingBase(applyBuy(nearlyDone, q))).toBe(0n);
  });

  it("formats the spot price per whole token", () => {
    expect(priceLamportsPerToken(fresh)).toMatch(/^\d+\.\d{9}$/);
  });

  it("slippage floors the minimum out", () => {
    expect(minOutWithSlippage(10_000n, 100)).toBe(9_900n);
    expect(() => minOutWithSlippage(1n, 10_001)).toThrow();
  });
});

describe("impact cap (SPEC §3.1)", () => {
  it("the largest allowed buy stays within the cap, one more lamport would not", () => {
    const max = maxBuyWithinImpact(fresh, 10n * SOL, 100);
    expect(max).toBeGreaterThan(0n);
    expect(max).toBeLessThan(10n * SOL);
    expect(buyImpactPpm(fresh, max)).toBeLessThanOrEqual(10_000n);
    expect(buyImpactPpm(fresh, max + 1n)).toBeGreaterThan(10_000n);
  });

  it("returns the whole budget when it fits", () => {
    const deep: CurveState = { ...fresh, realBase: CURVE.sellOnCurveBaseUnits / 2n, realQuote: 40n * SOL };
    const tiny = 1_000_000n;
    expect(maxBuyWithinImpact(deep, tiny, 100)).toBe(tiny);
  });

  it("impact is monotonic in size", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 5n * SOL }), fc.bigInt({ min: 1n, max: 5n * SOL }), (a, b) => {
        const [x, y] = a < b ? [a, b] : [b, a];
        return buyImpactPpm(fresh, x) <= buyImpactPpm(fresh, y);
      }),
      { numRuns: 100 },
    );
  });
});

describe("CPMM", () => {
  const pool: CpmmPoolState = { reserveBase: 200_000_000n * 10n ** 6n, reserveQuote: 85n * SOL, tradeFeePpm: 10_000n, creatorFeePpm: 0n, creatorFeeToken: "quote" };
  it("takes the trade fee off the input", () => {
    const q = quoteCpmmBuy(pool, SOL);
    expect(q.tradeFee).toBe(10_000_000n);
    expect(q.amountOut).toBeGreaterThan(0n);
  });
  it("creator fee on output reduces the output", () => {
    const withOut = quoteCpmmBuy({ ...pool, creatorFeePpm: 5000n, creatorFeeToken: "base" }, SOL);
    const without = quoteCpmmBuy(pool, SOL);
    expect(withOut.amountOut).toBeLessThan(without.amountOut);
  });
  it("sell: creator fee in SOL comes off the output; round trip loses fees", () => {
    const p2: CpmmPoolState = { ...pool, creatorFeePpm: 5000n, creatorFeeToken: "quote" };
    const b = quoteCpmmBuy(p2, SOL);
    expect(b.creatorFeeOnInput).toBe(true);
    const s1 = quoteCpmmSell(p2, b.amountOut);
    expect(s1.creatorFeeOnInput).toBe(false);
    expect(s1.amountOut).toBeLessThan(SOL);
    expect(cpmmSellImpactPpm(p2, b.amountOut)).toBeLessThan(0n);
  });
  it("max buy within impact respects the cap", () => {
    const max = maxCpmmBuyWithinImpact(pool, 10n * SOL, 100);
    expect(cpmmBuyImpactPpm(pool, max)).toBeLessThanOrEqual(10_000n);
    expect(cpmmBuyImpactPpm(pool, max + 1n)).toBeGreaterThan(10_000n);
  });
});
