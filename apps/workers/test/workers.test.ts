import { CURVE, FEES, splitPlatformFee, type LiveEvent } from "@backflow/core";
import type { ParsedLaunchLabTx } from "@backflow/chain";
import { getPrisma } from "@backflow/db";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTING, getSetting, setSetting, type Ctx } from "../src/ctx";
import { buybackTick, creditBuyback, recoverInflight, stepCoin } from "../src/jobs/buyback";
import { harvestCoin } from "../src/jobs/harvest";
import { indexMint, indexPlatform, type IndexerState } from "../src/jobs/indexer";
import { payCoin } from "../src/jobs/payout";
import { checkInvariants, reconcileTick } from "../src/jobs/reconcile";
import { FakeChain } from "./fake-chain";

const db = getPrisma();
const SOL = 1_000_000_000n;
const MINT = "CoinMint1111111111111111111111111111111back";
const POOL = "Poo11111111111111111111111111111111111111111";
const ALICE = "A1ice111111111111111111111111111111111111111";
const BOB = "Bob11111111111111111111111111111111111111111";
const CAROL = "Caro1111111111111111111111111111111111111111";

let chain: FakeChain;
let events: LiveEvent[];
let alerts: { kind: string; message: string }[];
let clock: Date;
let ctx: Ctx;
const state: IndexerState = { solUsd: 150 };

async function truncate() {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`);
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncate();
  chain = new FakeChain();
  events = [];
  alerts = [];
  clock = new Date("2026-11-04T12:00:00Z");
  chain.now = () => clock;
  ctx = { db, chain, live: { publish: async (e) => void events.push(e) }, alerts: { alert: async (kind, message) => void alerts.push({ kind, message }) }, log: pino({ level: "silent" }), now: () => clock };
});

const t = (s: number) => Math.floor(clock.getTime() / 1000) + s;

function tradeTx(signature: string, opts: { slot: number; time: number; trader: string; platformFee: bigint; amountIn?: bigint; create?: boolean }): ParsedLaunchLabTx {
  return {
    signature,
    slot: opts.slot,
    blockTime: opts.time,
    failed: false,
    creates: opts.create
      ? [
          {
            pool: POOL,
            mint: MINT,
            creator: ALICE,
            globalConfig: "G",
            platformConfig: chain.platformConfig,
            baseVault: "BV",
            quoteVault: "QV",
            event: { poolState: POOL, creator: ALICE, config: "G", decimals: 6, name: "Mochi", symbol: "MOCHI", uri: "https://ipfs.example/m.json", curveType: 0, supply: CURVE.supplyBaseUnits, totalBaseSell: CURVE.sellOnCurveBaseUnits, totalQuoteFundRaising: CURVE.graduationTargetLamports, migrateType: 1 },
          },
        ]
      : [],
    trades: [
      {
        eventIndex: 0,
        trader: opts.trader,
        poolState: POOL,
        totalBaseSell: CURVE.sellOnCurveBaseUnits,
        virtualBase: 1_073_000_000_000_000n,
        virtualQuote: 30n * SOL,
        realBaseBefore: 0n,
        realQuoteBefore: 0n,
        realBaseAfter: 1_000_000_000n,
        realQuoteAfter: opts.amountIn ?? SOL,
        amountIn: opts.amountIn ?? SOL,
        amountOut: 1_000_000_000n,
        protocolFee: 2_500_000n,
        platformFee: opts.platformFee,
        creatorFee: 1_750_000n,
        shareFee: 0n,
        direction: "buy",
        poolStatus: 0,
        exactIn: true,
      },
    ],
    migrations: [],
    balanceChanges: [],
  };
}

function balanceTx(signature: string, slot: number, time: number, changes: { owner: string; delta: bigint; programOwned?: boolean }[]): ParsedLaunchLabTx {
  return { signature, slot, blockTime: time, failed: false, creates: [], trades: [], migrations: [], balanceChanges: changes.map((c) => ({ mint: MINT, owner: c.owner, delta: c.delta, post: 0n, programOwned: c.programOwned ?? false })) };
}

function stream(address: string, txs: ParsedLaunchLabTx[]) {
  const list = chain.streams.get(address) ?? [];
  for (const tx of txs) {
    chain.txs.set(tx.signature, tx);
    list.push({ signature: tx.signature, slot: tx.slot, failed: false, blockTime: tx.blockTime });
  }
  chain.streams.set(address, list);
}

async function launchCoin(platformFee = 6_750_000n) {
  stream(chain.platformConfig, [tradeTx("s1", { slot: 10, time: t(-7200), trader: ALICE, platformFee, create: true })]);
  await indexPlatform(ctx, state);
}

describe("indexer", () => {
  it("creates the coin, records the trade with exact fees and credits the buyback budget", async () => {
    await launchCoin();
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.ticker).toBe("MOCHI");
    expect(coin.tickerSlot).toBe("mochi");
    expect(coin.description).toBe("test coin");
    const trade = await db.trade.findFirstOrThrow();
    expect(trade.feeExact).toBe(true);
    expect(trade.platformFee).toBe(6_750_000n);
    const acc = await db.feeAccrual.findFirstOrThrow();
    expect(acc.holdersPart).toBe(splitPlatformFee(6_750_000n).holders);
    expect(coin.buybackBudget).toBe(4_500_000n);
    expect(events.some((e) => e.type === "coin_created")).toBe(true);
    expect(await db.candle.count()).toBe(3);
  });

  it("is idempotent and restart-safe: re-running applies nothing twice", async () => {
    await launchCoin();
    await db.streamCursor.deleteMany(); // simulate a lost cursor: everything is re-read
    await indexPlatform(ctx, state);
    expect(await db.trade.count()).toBe(1);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(4_500_000n);
  });

  it("hides a second coin with a duplicate ticker", async () => {
    await launchCoin();
    const dup = tradeTx("s2", { slot: 11, time: t(-7000), trader: BOB, platformFee: 1n, create: true });
    dup.creates[0] = { ...dup.creates[0]!, mint: "OtherMint11111111111111111111111111111111", pool: "OtherPool1111111111111111111111111111111111", event: { ...dup.creates[0]!.event!, poolState: "OtherPool1111111111111111111111111111111111" } };
    dup.trades[0] = { ...dup.trades[0]!, poolState: "OtherPool1111111111111111111111111111111111" };
    stream(chain.platformConfig, [dup]);
    await indexPlatform(ctx, state);
    const other = await db.coin.findUniqueOrThrow({ where: { mint: "OtherMint11111111111111111111111111111111" } });
    expect(other.hidden).toBe(true);
    expect(other.tickerSlot).toBeNull();
  });

  it("tracks balances per wallet, skips program-owned accounts and flags decreases", async () => {
    await launchCoin();
    stream(MINT, [
      balanceTx("m1", 10, t(-7200), [{ owner: ALICE, delta: 1000n }, { owner: "CurveVaultPDA", delta: -1000n, programOwned: true }]),
      balanceTx("m2", 11, t(-3600), [{ owner: BOB, delta: 500n }]),
      balanceTx("m3", 12, t(-1800), [{ owner: ALICE, delta: -200n }]),
    ]);
    await indexMint(ctx, MINT, state);
    const alice = await db.holderState.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: ALICE } } });
    expect(alice.balance).toBe(800n);
    expect(alice.decreasedSincePayout).toBe(true);
    expect(await db.holderState.count({ where: { wallet: "CurveVaultPDA" } })).toBe(0);
    expect(await db.balanceEvent.count()).toBe(3);
  });
});

async function holders() {
  // Alice holds 3000 for 2h, Bob 1000 for 2h, Carol buys 1,000,000 one second before the buyback.
  stream(MINT, [
    balanceTx("h1", 10, t(-7200), [{ owner: ALICE, delta: 3000n }]),
    balanceTx("h2", 11, t(-7200), [{ owner: BOB, delta: 1000n }]),
    balanceTx("h3", 12, t(-1), [{ owner: CAROL, delta: 1_000_000n }]),
  ]);
  await indexMint(ctx, MINT, state);
}

describe("buyback worker", () => {
  beforeEach(async () => {
    await launchCoin();
    await holders();
    await db.coin.update({ where: { mint: MINT }, data: { buybackBudget: 1_200_000_000n } });
  });

  it("opens a round, buys in impact-capped chunks spaced apart, and credits holders by TWAB", async () => {
    chain.maxChunk = 400_000_000n;
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("opened");
    let coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.roundRemainingLamports).toBe(FEES.buyback.thresholdLamports);

    expect(await stepCoin(ctx, coin)).toBe("bought");
    let bb = await db.buyback.findFirstOrThrow({ where: { chunk: 0 } });
    expect(bb.status).toBe("CONFIRMED");
    expect(bb.solSpent).toBe(400_000_000n);
    expect(bb.signature).toBeTruthy();
    // a second chunk waits until this one is credited
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("waiting");

    // the indexer has seen the buyback slot → credit
    await db.streamCursor.update({ where: { stream: `mint:${MINT}` }, data: { slot: 10_000n } });
    await buybackTick(ctx);
    bb = await db.buyback.findUniqueOrThrow({ where: { id: bb.id } });
    expect(bb.credited).toBe(true);
    const credits = await db.rewardCredit.findMany({ where: { buybackId: bb.id } });
    const sum = credits.reduce((s, c) => s + c.amount, 0n);
    expect(sum + bb.dustCarried).toBe(bb.tokensBought);
    const by = Object.fromEntries(credits.map((c) => [c.wallet, c.amount]));
    expect(by[ALICE]!).toBeGreaterThan(by[BOB]!);
    expect(by[CAROL] ?? 0n).toBeLessThan(by[BOB]!); // the 1-second sniper earns less than a small long-time holder
    expect(events.some((e) => e.type === "buyback")).toBe(true);

    // spacing: the next chunk waits ≥ 20 s
    coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(await stepCoin(ctx, coin)).toBe("waiting");
    clock = new Date(clock.getTime() + 25_000);
    expect(await stepCoin(ctx, coin)).toBe("bought");
    await db.streamCursor.update({ where: { stream: `mint:${MINT}` }, data: { slot: 10_000n } });
    await buybackTick(ctx);
    clock = new Date(clock.getTime() + 25_000);
    await buybackTick(ctx);
    await buybackTick(ctx);
    coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    const all = await db.buyback.findMany({ where: { status: "CONFIRMED" }, orderBy: { chunk: "asc" } });
    expect(all.map((b) => b.solSpent)).toEqual([400_000_000n, 400_000_000n, 200_000_000n]);
    expect(coin.roundRemainingLamports).toBe(0n);
    expect(coin.buybackBudget).toBe(200_000_000n);
    expect(coin.paidToHoldersLamports).toBe(SOL);
    expect(coin.buybackCount).toBe(3);
    // chunks of one round share the window start
    expect(new Set(all.map((b) => b.windowStart.toISOString())).size).toBe(1);
    expect(coin.lastDistributionAt!.getTime()).toBe(all[2]!.windowEnd.getTime());
  });

  it("refunds the budget when the transaction fails or expires", async () => {
    const coin0 = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    await stepCoin(ctx, coin0); // open round
    chain.outcomes = ["dropped"];
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("failed");
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.buybackBudget).toBe(1_200_000_000n);
    expect(coin.roundRemainingLamports).toBe(FEES.buyback.thresholdLamports);
    expect((await db.buyback.findFirstOrThrow()).status).toBe("FAILED");
  });

  it("refunds when simulation fails, and never sends", async () => {
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }));
    chain.failPrepare = true;
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("failed");
    expect(chain.sent).toHaveLength(0);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(1_200_000_000n);
  });

  it("recovers a SENT buyback after a crash by checking its signature (no double spend)", async () => {
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }));
    chain.outcomes = ["pending"]; // process "dies" while waiting
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }));
    const row = await db.buyback.findFirstOrThrow();
    expect(row.status).toBe("SENT");
    // it landed after all
    chain.statuses.set(row.signature!, "confirmed");
    await recoverInflight(ctx);
    expect((await db.buyback.findFirstOrThrow()).status).toBe("CONFIRMED");
    expect(chain.sent.filter((s) => s.kind === "bb")).toHaveLength(1);
  });

  it("does nothing while buybacks are paused", async () => {
    await setSetting(db, SETTING.buybacksPaused, true);
    await buybackTick(ctx);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).roundRemainingLamports).toBe(0n);
  });

  it("credits carried dust and forfeitures into the next distribution", async () => {
    await db.coin.update({ where: { mint: MINT }, data: { forfeitPool: 777n, rewardDust: 3n } });
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }));
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }));
    await db.streamCursor.update({ where: { stream: `mint:${MINT}` }, data: { slot: 10_000n } });
    const bb = await db.buyback.findFirstOrThrow();
    await creditBuyback(ctx, bb.id);
    const credits = await db.rewardCredit.aggregate({ where: { buybackId: bb.id }, _sum: { amount: true } });
    const after = await db.buyback.findUniqueOrThrow({ where: { id: bb.id } });
    expect((credits._sum.amount ?? 0n) + after.dustCarried).toBe(bb.tokensBought + 780n);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).forfeitPool).toBe(0n);
  });
});

describe("payout worker", () => {
  beforeEach(async () => {
    await launchCoin();
    await db.coin.update({ where: { mint: MINT }, data: { mcapUsd: 150_000 } }); // $0.00015 per token
    await db.pending.createMany({
      data: [
        { coinMint: MINT, wallet: ALICE, amount: 10_000_000_000n }, // 10,000 tokens = $1.50
        { coinMint: MINT, wallet: BOB, amount: 1_000_000_000n }, // 1,000 tokens = $0.15 → rolls over
        { coinMint: MINT, wallet: CAROL, amount: 50_000_000_000n }, // sold since last payout → forfeited
      ],
    });
    await db.holderState.createMany({
      data: [
        { coinMint: MINT, wallet: ALICE, balance: 1n },
        { coinMint: MINT, wallet: BOB, balance: 1n },
        { coinMint: MINT, wallet: CAROL, balance: 1n, decreasedSincePayout: true },
      ],
    });
  });

  it("pays, rolls over below the minimum and forfeits sellers", async () => {
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    const paid = await payCoin(ctx, coin, 1);
    expect(paid).toEqual([ALICE]);
    const p = (w: string) => db.pending.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: w } } }).then((r) => r.amount);
    expect(await p(ALICE)).toBe(0n);
    expect(await p(BOB)).toBe(1_000_000_000n);
    expect(await p(CAROL)).toBe(0n);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).forfeitPool).toBe(50_000_000_000n);
    const alice = await db.holderState.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: ALICE } } });
    expect(alice.receivedTotal).toBe(10_000_000_000n);
    expect(await db.holderState.count({ where: { decreasedSincePayout: true } })).toBe(0);
    const payout = await db.payout.findFirstOrThrow();
    expect(payout.status).toBe("CONFIRMED");
    // idempotent per (coin, round)
    expect(await payCoin(ctx, coin, 1)).toEqual([]);
  });

  it("restores pending when a batch fails", async () => {
    chain.outcomes = ["failed"];
    await payCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }), 1);
    expect((await db.pending.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: ALICE } } })).amount).toBe(10_000_000_000n);
    expect((await db.payoutItem.findFirstOrThrow()).status).toBe("FAILED");
  });

  it("rolls over wallets whose token account was closed", async () => {
    chain.missingAtas.add(ALICE);
    expect(await payCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }), 1)).toEqual([]);
    expect((await db.pending.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: ALICE } } })).amount).toBe(10_000_000_000n);
  });

  it("skips and alerts when the distributor is short", async () => {
    chain.tokens.set(`${chain.wallets.distributor}|${MINT}`, 1n);
    expect(await payCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }), 1)).toEqual([]);
    expect(await db.payout.count()).toBe(0);
    expect(alerts.map((a) => a.kind)).toContain("distributor_short");
  });
});

describe("reconcile worker", () => {
  beforeEach(async () => {
    await launchCoin(6_750_000n);
    chain.slot = 20; // indexer caught up (cursor at slot 10)
  });

  it("claims the vault, checks it against accruals and splits it", async () => {
    chain.vault = 6_750_000n;
    await reconcileTick(ctx);
    const c = await db.vaultClaim.findFirstOrThrow();
    expect(c.status).toBe("CONFIRMED");
    expect(c.stage).toBe("done");
    expect(c.claimedLamports).toBe(6_750_000n);
    expect(c.toBuybackLamports).toBe(4_500_000n);
    expect(c.toTreasuryLamports).toBe(2_250_000n);
    expect(await getSetting(db, SETTING.buybacksPaused, false)).toBe(false);
  });

  it("pauses buybacks and alerts on a mismatch over 0.5%", async () => {
    chain.vault = 8_000_000n;
    await reconcileTick(ctx);
    const c = await db.vaultClaim.findFirstOrThrow();
    expect(c.stage).toBe("held");
    expect(await getSetting(db, SETTING.buybacksPaused, false)).toBe(true);
    expect(alerts.map((a) => a.kind)).toContain("reconcile_mismatch");
  });
});

describe("money invariants", () => {
  beforeEach(async () => {
    await launchCoin();
    await db.pending.create({ data: { coinMint: MINT, wallet: ALICE, amount: 1_000n } });
    await db.coin.update({ where: { mint: MINT }, data: { forfeitPool: 200n, rewardDust: 3n } });
  });

  it("passes when the distributor holds what holders are owed", async () => {
    chain.tokens.set(`${chain.wallets.distributor}|${MINT}`, 1_203n);
    const r = await checkInvariants(ctx);
    expect(r.tokenShortfalls).toEqual([]);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).payoutsPaused).toBe(false);
  });

  it("pauses the coin's payouts and alerts on a token shortfall", async () => {
    chain.tokens.set(`${chain.wallets.distributor}|${MINT}`, 1_202n);
    const r = await checkInvariants(ctx);
    expect(r.tokenShortfalls).toEqual([{ mint: MINT, owed: 1_203n, held: 1_202n }]);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).payoutsPaused).toBe(true);
    expect(alerts.map((a) => a.kind)).toContain("invariant_tokens");
  });

  it("pauses buybacks when the buyback wallet holds less than funded budgets", async () => {
    // budget 4.5M is still in the fee vault (unclaimed accrual) → not funded yet → fine
    chain.sol.set(chain.wallets.buyback, 0n);
    expect((await checkInvariants(ctx)).solShortfall).toBeNull();
    // pretend 5 SOL of budget was funded
    await db.coin.update({ where: { mint: MINT }, data: { buybackBudget: 5n * SOL + 4_500_000n } });
    const r = await checkInvariants(ctx);
    expect(r.solShortfall?.owed).toBe(5n * SOL);
    expect(await getSetting(db, SETTING.buybacksPaused, false)).toBe(true);
  });
});

describe("harvest worker", () => {
  it("harvests a graduated pool, sends 2/3 SOL to buybacks and all coin tokens to holders", async () => {
    await launchCoin();
    await db.coin.update({ where: { mint: MINT }, data: { status: "GRADUATED", cpmmPoolId: "CpmmPoo111111111111111111111111111111111111" } });
    expect(await harvestCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("harvested");
    const h = await db.harvest.findFirstOrThrow();
    expect(h.solToBuyback).toBe(200n);
    expect(h.solToPlatform).toBe(100n);
    expect(h.tokensToHolders).toBe(5000n);
    expect(h.settled).toBe(true);
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.extraRewardTokens).toBe(5000n);
    expect(coin.buybackBudget).toBe(4_500_000n + 200n);
  });
});
