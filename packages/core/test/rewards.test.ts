import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  batches,
  candleOpen,
  decreasedSince,
  distribute,
  minPayoutTokens,
  nextBuybackStep,
  planPayout,
  reconcile,
  splitHarvest,
  twabWeight,
  twabWeights,
  type HolderHistory,
} from "../src/rewards";

const T0 = 1_000_000;
const H = 3600;

describe("TWAB (SPEC §3.2)", () => {
  it("constant balance over the window", () => {
    expect(twabWeight({ startBalance: 100n, points: [] }, T0, T0 + H)).toBe(100n * BigInt(H));
  });

  it("deposit mid-window counts only from the deposit", () => {
    const h: HolderHistory = { startBalance: 0n, points: [{ t: T0 + 1800, balance: 100n }] };
    expect(twabWeight(h, T0, T0 + H)).toBe(100n * 1800n);
  });

  it("withdrawal mid-window counts until the withdrawal", () => {
    const h: HolderHistory = { startBalance: 100n, points: [{ t: T0 + 600, balance: 40n }] };
    expect(twabWeight(h, T0, T0 + H)).toBe(100n * 600n + 40n * 3000n);
  });

  it("buying 1 second before the buyback earns almost nothing (anti-sniping)", () => {
    const holder = twabWeight({ startBalance: 1_000n, points: [] }, T0, T0 + H);
    const sniper = twabWeight({ startBalance: 0n, points: [{ t: T0 + H - 1, balance: 1_000_000n }] }, T0, T0 + H);
    const d = distribute(1_000_000n, new Map([["holder", holder], ["sniper", sniper]]));
    expect(d.credits.get("holder")!).toBeGreaterThan(d.credits.get("sniper")!);
  });

  it("ignores points outside the window and sorts unsorted points", () => {
    const h: HolderHistory = {
      startBalance: 10n,
      points: [
        { t: T0 + 2000, balance: 30n },
        { t: T0 - 50, balance: 999n },
        { t: T0 + 1000, balance: 20n },
        { t: T0 + H + 5, balance: 999n },
      ],
    };
    expect(twabWeight(h, T0, T0 + H)).toBe(10n * 1000n + 20n * 1000n + 30n * 1600n);
  });

  it("drops excluded wallets and zero weights", () => {
    const m = new Map<string, HolderHistory>([
      ["curveVault", { startBalance: 1_000_000n, points: [] }],
      ["alice", { startBalance: 10n, points: [] }],
      ["gone", { startBalance: 0n, points: [] }],
    ]);
    const w = twabWeights(m, T0, T0 + H, new Set(["curveVault"]));
    expect([...w.keys()]).toEqual(["alice"]);
  });
});

describe("distribute", () => {
  it("splits pro rata with dust carried", () => {
    const d = distribute(10n, new Map([["a", 1n], ["b", 1n], ["c", 1n]]));
    expect([...d.credits.values()]).toEqual([3n, 3n, 3n]);
    expect(d.dust).toBe(1n);
  });

  it("all dust when nobody is eligible", () => {
    expect(distribute(500n, new Map())).toEqual({ credits: new Map(), dust: 500n });
  });

  it("property: Σ credited + dust = tokens bought, dust < recipients, for any balance history", () => {
    const history = fc.record({
      startBalance: fc.bigInt({ min: 0n, max: 10n ** 15n }),
      points: fc.array(fc.record({ t: fc.integer({ min: T0, max: T0 + H - 1 }), balance: fc.bigInt({ min: 0n, max: 10n ** 15n }) }), { maxLength: 8 }),
    });
    fc.assert(
      fc.property(fc.array(history, { minLength: 1, maxLength: 30 }), fc.bigInt({ min: 0n, max: 10n ** 15n }), (hs, total) => {
        const m = new Map(hs.map((h, i) => [`w${i}`, h] as const));
        const weights = twabWeights(m, T0, T0 + H, new Set());
        const d = distribute(total, weights);
        let sum = 0n;
        for (const c of d.credits.values()) sum += c;
        return sum + d.dust === total && d.dust >= 0n && (weights.size === 0 || d.dust < BigInt(Math.max(1, weights.size)) || total === d.dust);
      }),
      { numRuns: 300 },
    );
  });
});

describe("forfeiture (SPEC §3.3)", () => {
  it("sell forfeits", () => expect(decreasedSince([100n, -50n])).toBe(true));
  it("transfer out forfeits", () => expect(decreasedSince([-1n])).toBe(true));
  it("partial sell forfeits", () => expect(decreasedSince([500n, -1n, 200n])).toBe(true));
  it("buy-only keeps pending", () => expect(decreasedSince([10n, 20n])).toBe(false));
  it("no activity keeps pending", () => expect(decreasedSince([])).toBe(false));
});

describe("planPayout", () => {
  it("pays, rolls over below the minimum, and forfeits decreased wallets", () => {
    const plan = planPayout(
      [
        { wallet: "a", amount: 1_000n, decreased: false },
        { wallet: "b", amount: 50n, decreased: false },
        { wallet: "c", amount: 700n, decreased: true },
        { wallet: "d", amount: 0n, decreased: false },
      ],
      100n,
    );
    expect(plan.pay).toEqual([{ wallet: "a", amount: 1_000n }]);
    expect(plan.rollover).toEqual([{ wallet: "b", amount: 50n }]);
    expect(plan.forfeited).toBe(700n);
    expect(plan.forfeitedWallets).toEqual(["c"]);
    expect(plan.total).toBe(1_000n);
  });

  it("property: pay + rollover + forfeited = all pending", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ wallet: fc.string(), amount: fc.bigInt({ min: 0n, max: 10n ** 12n }), decreased: fc.boolean() })), fc.bigInt({ min: 0n, max: 10n ** 9n }), (es, min) => {
        const p = planPayout(es, min);
        const all = es.reduce((s, e) => s + e.amount, 0n);
        const accounted = p.total + p.rollover.reduce((s, r) => s + r.amount, 0n) + p.forfeited;
        return all === accounted;
      }),
    );
  });

  it("minimum payout in tokens from USD", () => {
    // $0.50 at $0.001 per token = 500 tokens = 500_000_000 base units (6 decimals)
    expect(minPayoutTokens(0.001, 6, 0.5)).toBe(500_000_000n);
    expect(minPayoutTokens(null)).toBeNull();
    expect(minPayoutTokens(0.001, 6, 0)).toBe(0n);
  });

  it("batches", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => batches([1], 0)).toThrow();
  });
});

describe("buyback rounds and impact-cap chunking", () => {
  it("opens a round at the threshold and waits below it", () => {
    expect(nextBuybackStep({ budget: 999_999_999n, roundRemaining: 0n, maxChunk: 10n ** 12n, secondsSinceLastChunk: 999 }).action).toBe("wait");
    const s = nextBuybackStep({ budget: 1_000_000_000n, roundRemaining: 0n, maxChunk: 10n ** 12n, secondsSinceLastChunk: 999 });
    expect(s).toMatchObject({ action: "open_round", roundSize: 1_000_000_000n });
  });

  it("splits a 1 SOL round into chunks spaced 20s apart", () => {
    let remaining = 1_000_000_000n;
    let budget = 1_200_000_000n;
    let since = 999;
    const chunks: bigint[] = [];
    for (let i = 0; i < 100 && remaining > 0n; i++) {
      const st = nextBuybackStep({ budget, roundRemaining: remaining, maxChunk: 150_000_000n, secondsSinceLastChunk: since });
      if (st.action === "buy") {
        chunks.push(st.amount);
        remaining -= st.amount;
        budget -= st.amount;
        since = 0;
      } else since += 5;
    }
    expect(chunks.reduce((a, b) => a + b, 0n)).toBe(1_000_000_000n);
    expect(chunks.length).toBe(7);
    expect(chunks.every((c) => c <= 150_000_000n)).toBe(true);
  });

  it("never spends more than the budget", () => {
    const st = nextBuybackStep({ budget: 100n, roundRemaining: 1_000n, maxChunk: 10_000n, secondsSinceLastChunk: 999 });
    expect(st.amount).toBe(100n);
  });
});

describe("reconcile and harvest", () => {
  it("passes within 0.5% and fails beyond", () => {
    expect(reconcile(1_004_000n, 1_000_000n).ok).toBe(true);
    expect(reconcile(1_006_000n, 1_000_000n).ok).toBe(false);
    expect(reconcile(0n, 0n).ok).toBe(true);
    expect(reconcile(1n, 0n).ok).toBe(false);
  });
  it("splits harvested SOL 2/3 to buyback with dust to the platform; all coin tokens to holders", () => {
    expect(splitHarvest(10n, 77n)).toEqual({ solToBuyback: 6n, solToPlatform: 4n, tokensToHolders: 77n, tokensToPlatform: 0n });
  });
  it("candle buckets", () => {
    expect(candleOpen(1_000_123, 60)).toBe(1_000_080);
  });
});
