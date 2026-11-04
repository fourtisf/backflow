import { BRAND } from "@backflow/core";
import type { CoinRow, LiveEvent } from "@backflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { MockProvider } from "../src/mock/provider";

let now = Date.parse("2026-11-04T12:00:00Z");
let provider: MockProvider;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  now = Date.parse("2026-11-04T12:00:00Z");
  provider = new MockProvider({ tickMs: 0, now: () => now });
  app = await buildApp({ provider });
});
afterEach(async () => {
  await app.close();
});

const json = async <T>(url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as T };
};

describe("mock API", () => {
  it("lists coins per tab with base-unit strings", async () => {
    const { status, body } = await json<{ coins: CoinRow[] }>("/coins?tab=trending");
    expect(status).toBe(200);
    expect(body.coins.length).toBe(18);
    const c = body.coins[0]!;
    expect(c.paidToHoldersLamports).toMatch(/^\d+$/);
    expect(c.spark).toHaveLength(32);
    // trending = 24h volume, descending
    for (let i = 1; i < body.coins.length; i++) expect(body.coins[i - 1]!.vol24hUsd!).toBeGreaterThanOrEqual(body.coins[i]!.vol24hUsd!);

    const raydium = await json<{ coins: CoinRow[] }>("/coins?tab=raydium");
    expect(raydium.body.coins.every((x) => x.status === "graduated")).toBe(true);
    const near = await json<{ coins: CoinRow[] }>("/coins?tab=near");
    expect(near.body.coins.every((x) => x.status === "curve" && BigInt(x.curveQuoteLamports) * 2n >= BigInt(x.graduationTargetLamports))).toBe(true);
  });

  it("searches by name or ticker", async () => {
    const { body } = await json<{ coins: CoinRow[] }>("/coins?q=moch");
    expect(body.coins.map((c) => c.ticker)).toEqual(["MOCHI"]);
  });

  it("serves coin detail, candles, trades, buybacks and holders", async () => {
    const { body } = await json<{ coins: CoinRow[] }>("/coins");
    const mint = body.coins[0]!.mint;
    expect(mint.endsWith("back")).toBe(true);
    expect((await json(`/coins/${mint}`)).status).toBe(200);
    const candles = await json<{ candles: { t: number }[] }>(`/coins/${mint}/candles?tf=5m`);
    expect(candles.body.candles.length).toBeGreaterThan(50);
    expect(candles.body.candles.every((c) => c.t % 300_000 === 0)).toBe(true);
    expect((await json<{ trades: unknown[] }>(`/coins/${mint}/trades`)).body.trades.length).toBeGreaterThan(0);
    expect((await json<{ buybacks: unknown[] }>(`/coins/${mint}/buybacks`)).body.buybacks.length).toBe(8);
    const holders = await json<{ holders: { excluded: boolean }[] }>(`/coins/${mint}/holders`);
    expect(holders.body.holders[0]!.excluded).toBe(true);
  });

  it("404s unknown coins with plain copy", async () => {
    const r = await json<{ message: string }>("/coins/nope");
    expect(r.status).toBe(404);
    expect(r.body.message).toBe(`This coin isn't on ${BRAND.name}.`);
  });

  it("checks ticker availability case-insensitively", async () => {
    expect((await json<{ available: boolean; reason: string }>("/tickers/mochi/available")).body).toMatchObject({
      available: false,
      reason: `$MOCHI already exists on ${BRAND.name}. Pick another ticker.`,
    });
    expect((await json<{ available: boolean }>("/tickers/NEWCOIN/available")).body.available).toBe(true);
  });

  it("validates wallet addresses", async () => {
    expect((await json("/wallet/not-an-address/rewards")).status).toBe(400);
    const r = await json<{ coins: { pending: string }[] }>("/wallet/Gq4mABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk8VtZ/rewards");
    expect(r.status).toBe(200);
    expect(r.body.coins.length).toBe(3);
  });

  it("reports mock mode in stats", async () => {
    const r = await json<{ mode: string; payoutIntervalSec: number }>("/stats");
    expect(r.body.mode).toBe("mock");
    expect(r.body.payoutIntervalSec).toBe(300);
  });
});

describe("mock simulation", () => {
  it("fills vaults, fires buybacks and keeps lamports integral", async () => {
    const events: LiveEvent[] = [];
    provider.subscribe((e) => events.push(e));
    for (let i = 0; i < 400; i++) {
      now += 1000;
      provider.step();
    }
    const bbs = events.filter((e) => e.type === "buyback");
    expect(bbs.length).toBeGreaterThan(0);
    for (const e of events) {
      if (e.type === "vault") expect(e.buybackBudgetLamports).toMatch(/^\d+$/);
    }
    // a payout fires within the first interval
    expect(events.some((e) => e.type === "payout")).toBe(true);
  });

  it("credits pending to a holding wallet on buybacks and pays it out", async () => {
    const wallet = "Gq4mABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk8VtZ";
    const before = await provider.walletRewards(wallet);
    const recvBefore = before.coins.reduce((s, c) => s + BigInt(c.received), 0n);
    for (let i = 0; i < 700; i++) {
      now += 1000;
      provider.step();
    }
    const after = await provider.walletRewards(wallet);
    const recvAfter = after.coins.reduce((s, c) => s + BigInt(c.received), 0n);
    expect(recvAfter).toBeGreaterThan(recvBefore);
  });
});
