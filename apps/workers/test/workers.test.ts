import { CURVE, FEES, splitPlatformFee, type LiveEvent } from "@backflow/core";
import type { ParsedLaunchLabTx } from "@backflow/chain";
import { getPrisma } from "@backflow/db";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTING, getSetting, setSetting, type Ctx } from "../src/ctx";
import { buybackTick, creditBuyback, recoverInflight, stepCoin } from "../src/jobs/buyback";
import { harvestCoin, settleHarvest } from "../src/jobs/harvest";
import { fillMetadata, indexMint, indexPlatform, syncHolders, type IndexerState } from "../src/jobs/indexer";
import { collectSignatures } from "../src/chain";
import { checkJupiterInstructions, JUPITER_V6 } from "../src/jupiter";
import { acquireLease, releaseLease } from "../src/runner";
import { guardedLookup } from "../src/safe-fetch";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { payCoin, recoverPayouts } from "../src/jobs/payout";
import { assignClaim, checkInvariants, reconcileTick, splitPro } from "../src/jobs/reconcile";
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

function tradeTx(signature: string, opts: { slot: number; time: number; trader: string; platformFee: bigint; amountIn?: bigint; create?: boolean; globalConfig?: string; curveType?: number }): ParsedLaunchLabTx {
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
            globalConfig: opts.globalConfig ?? "G",
            platformConfig: chain.platformConfig,
            baseVault: "BV",
            quoteVault: "QV",
            tokenProgram: "spl",
            event: { poolState: POOL, creator: ALICE, config: opts.globalConfig ?? "G", decimals: 6, name: "Mochi", symbol: "MOCHI", uri: "https://ipfs.example/m.json", curveType: opts.curveType ?? 0, supply: CURVE.supplyBaseUnits, totalBaseSell: CURVE.sellOnCurveBaseUnits, totalQuoteFundRaising: CURVE.graduationTargetLamports, migrateType: 1 },
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
    warnings: [],
  };
}

function balanceTx(signature: string, slot: number, time: number, changes: { owner: string; delta: bigint; programOwned?: boolean }[]): ParsedLaunchLabTx {
  return { signature, slot, blockTime: time, failed: false, creates: [], trades: [], migrations: [], warnings: [], balanceChanges: changes.map((c) => ({ mint: MINT, owner: c.owner, delta: c.delta, post: 0n, programOwned: c.programOwned ?? false })) };
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
  it("never indexes a launch under our platform config with another GlobalConfig or curve (audit)", async () => {
    for (const o of [{ globalConfig: "USD1Config" }, { curveType: 1 }]) {
      stream(chain.platformConfig, [tradeTx("x" + JSON.stringify(o).length, { slot: 10, time: t(-7200), trader: ALICE, platformFee: 6_750_000n, create: true, ...o })]);
      await indexPlatform(ctx, state);
      expect(await db.coin.count()).toBe(0);
      expect(await db.feeAccrual.count()).toBe(0); // its fees would be in another unit or another vault
    }
  });

  it("creates the coin, records the trade with exact fees and credits the buyback budget", async () => {
    await launchCoin();
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.ticker).toBe("MOCHI");
    expect(coin.tickerSlot).toBe("mochi");
    expect(coin.metadataStatus).toBe("pending"); // never fetched inside the indexer transaction
    expect(await fillMetadata(ctx)).toBe(1);
    const meta = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(meta.description).toBe("test coin");
    expect(meta.imageUri).toBe("https://gateway.pinata.cloud/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
    expect(meta.x).toBe("https://x.com/mochi");
    expect(meta.website).toBeNull(); // javascript: link dropped
    const trade = await db.trade.findFirstOrThrow();
    expect(trade.feeExact).toBe(true);
    expect(trade.platformFee).toBe(6_750_000n);
    const acc = await db.feeAccrual.findFirstOrThrow();
    expect(acc.holdersPart).toBe(splitPlatformFee(6_750_000n).holders);
    expect(coin.buybackBudget).toBe(4_500_000n);
    expect(events.some((e) => e.type === "coin_created")).toBe(true);
    expect(await db.candle.count()).toBe(6);
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

  it("spends only budget whose SOL has reached the server wallet (audit)", async () => {
    // budget at exactly the threshold, but 0.0045 SOL of it is still in the fee vault (launchCoin's trade)
    await db.coin.update({ where: { mint: MINT }, data: { buybackBudget: FEES.buyback.thresholdLamports } });
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("waiting");
    // once the claim that swept it is through its transfer, the round can open
    const claim = await db.vaultClaim.create({ data: { status: "CONFIRMED", stage: "done", claimedLamports: 6_750_000n } });
    await db.feeAccrual.updateMany({ where: { coinMint: MINT }, data: { claimId: claim.id } });
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("opened");
  });

  it("with one server wallet, keeps the SOL of a claim that is still being split out of a buyback (audit)", async () => {
    const w = chain.wallets as { buyback: string; claim: string };
    const saved = w.buyback;
    w.buyback = w.claim;
    try {
      chain.maxChunk = 400_000_000n;
      await db.vaultClaim.create({ data: { status: "CONFIRMED", stage: "transfer", claimedLamports: 10n ** 12n } });
      expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("opened");
      expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("waiting");
      expect(alerts.map((a) => a.kind)).toContain("low_balance");
      expect(chain.sent.filter((t) => t.kind === "bb")).toHaveLength(0);
    } finally {
      w.buyback = saved;
    }
  });

  it("with one server wallet, gives up a buy if a harvest started meanwhile (audit)", async () => {
    const w = chain.wallets as { buyback: string; claim: string };
    const saved = w.buyback;
    w.buyback = w.claim;
    try {
      chain.maxChunk = 400_000_000n;
      expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("opened");
      const before = (await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget;
      await db.harvest.create({ data: { coinMint: MINT, status: "SENT", signature: "h2" } }); // lands in another process
      expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("waiting");
      expect(chain.sent.filter((t) => t.kind === "bb")).toHaveLength(0);
      expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(before); // refunded in full
    } finally {
      w.buyback = saved;
    }
  });

  it("with one server wallet, waits while a harvest's wSOL is unsettled (audit)", async () => {
    const w = chain.wallets as { buyback: string; claim: string };
    const saved = w.buyback;
    w.buyback = w.claim;
    try {
      await db.harvest.create({ data: { coinMint: MINT, status: "CONFIRMED", settled: false, signature: "h1" } });
      await buybackTick(ctx);
      expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).roundRemainingLamports).toBe(0n);
      await db.harvest.updateMany({ data: { settled: true } });
      await buybackTick(ctx);
      expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).roundRemainingLamports).toBe(FEES.buyback.thresholdLamports);
    } finally {
      w.buyback = saved;
    }
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

    // the indexer has seen the buyback slot, but holders weren't resynced after the window → no credit yet
    await db.streamCursor.update({ where: { stream: `mint:${MINT}` }, data: { slot: 10_000n } });
    await buybackTick(ctx);
    expect((await db.buyback.findUniqueOrThrow({ where: { id: bb.id } })).credited).toBe(false);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).needsHolderSync).toBe(true);
    await indexMint(ctx, MINT, state); // the indexer runs the sync
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
    await buybackTick(ctx);
    await indexMint(ctx, MINT, state);
    await buybackTick(ctx);
    clock = new Date(clock.getTime() + 25_000);
    await buybackTick(ctx); // buys the last chunk
    await buybackTick(ctx); // asks for a holder sync before crediting it
    await indexMint(ctx, MINT, state);
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
    expect(after.carriedIn).toBe(780n);
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
    await db.coin.update({ where: { mint: MINT }, data: { holderSyncedAt: clock } }); // the indexer synced holders for this round
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
    expect(await db.forfeiture.findMany({ select: { wallet: true, amount: true } })).toEqual([{ wallet: CAROL, amount: 50_000_000_000n }]);
    const alice = await db.holderState.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: ALICE } } });
    expect(alice.receivedTotal).toBe(10_000_000_000n);
    expect(await db.holderState.count({ where: { decreasedSincePayout: true } })).toBe(0);
    const payout = await db.payout.findFirstOrThrow();
    expect(payout.status).toBe("CONFIRMED");
    // idempotent per (coin, round)
    expect(await payCoin(ctx, coin, 1)).toEqual([]);
  });

  it("charges each landed batch's network fee to the coin's holder budget, once (D-049)", async () => {
    chain.fee = 12_345n;
    await db.coin.update({ where: { mint: MINT }, data: { buybackBudget: 1_000_000n } });
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(await payCoin(ctx, coin, 1)).toEqual([ALICE]);
    const payout = await db.payout.findFirstOrThrow();
    expect(payout.feeLamports).toBe(12_345n);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(1_000_000n - 12_345n);
    // re-checking a settled batch charges nothing again
    await recoverPayouts(ctx);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(1_000_000n - 12_345n);
  });

  it("lets the budget go below zero and waits for new fees before buying again (D-049)", async () => {
    chain.fee = 20_000n;
    await db.coin.update({ where: { mint: MINT }, data: { buybackBudget: 5_000n } });
    await payCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }), 1);
    const c = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(c.buybackBudget).toBe(-15_000n);
    await db.coin.update({ where: { mint: MINT }, data: { roundRemainingLamports: 1_000_000n } });
    const before = chain.sent.filter((t) => t.kind === "bb").length;
    await buybackTick(ctx);
    expect(chain.sent.filter((t) => t.kind === "bb").length).toBe(before);
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

/** The claim references the PlatformConfig, so the indexer sees it in the platform stream. */
async function indexClaim() {
  const c = await db.vaultClaim.findFirstOrThrow();
  stream(chain.platformConfig, [{ signature: c.signature!, slot: Number(c.slot), blockTime: t(0), failed: false, creates: [], trades: [], migrations: [], balanceChanges: [], warnings: [] }]);
  await indexPlatform(ctx, state);
  await reconcileTick(ctx);
}

describe("reconcile worker", () => {
  beforeEach(async () => {
    await launchCoin(6_750_000n);
    chain.slot = 20; // indexer caught up (cursor at slot 10)
  });

  it("charges the claim's network fee to the holders' share of the coins it swept, once (D-053)", async () => {
    chain.fee = 9_000n;
    chain.vault = 6_750_000n;
    await reconcileTick(ctx);
    await indexClaim();
    const c = await db.vaultClaim.findFirstOrThrow();
    expect(c.feeLamports).toBe(9_000n);
    expect(c.feeCharged).toBe(true);
    // launchCoin credited 4,500,000 to the budget; the only coin in the claim pays the whole fee
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(4_500_000n - 9_000n);
    await assignClaim(ctx, c.id);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(4_500_000n - 9_000n);
  });

  it("splits a fee over coins by weight, exactly", () => {
    const parts = splitPro(10n, [{ key: "a", weight: 1n }, { key: "b", weight: 2n }, { key: "c", weight: 0n }]);
    expect(parts.reduce((s, p) => s + p.amount, 0n)).toBe(10n);
    expect(parts).toEqual([{ key: "a", amount: 3n }, { key: "b", amount: 7n }]);
  });

  it("claims the vault, checks it against accruals and splits it", async () => {
    chain.vault = 6_750_000n;
    await reconcileTick(ctx);
    expect((await db.vaultClaim.findFirstOrThrow()).stage).toBe("assign"); // waits until the indexer passed the claim
    await indexClaim();
    const c = await db.vaultClaim.findFirstOrThrow();
    expect(c.status).toBe("CONFIRMED");
    expect(c.stage).toBe("done");
    expect(c.claimedLamports).toBe(6_750_000n);
    expect(c.toBuybackLamports).toBe(4_500_000n);
    expect(c.toTreasuryLamports).toBe(2_250_000n);
    expect(await getSetting(db, SETTING.buybacksPaused, false)).toBe(false);
  });

  it("with one server wallet, only the platform share leaves it (D-045)", async () => {
    const w = chain.wallets as { buyback: string; distributor: string; claim: string };
    const saved = { buyback: w.buyback, distributor: w.distributor };
    w.buyback = w.distributor = w.claim;
    try {
      chain.vault = 6_750_000n;
      await reconcileTick(ctx);
      await indexClaim();
      const c = await db.vaultClaim.findFirstOrThrow();
      expect(c.stage).toBe("done");
      expect(c.toBuybackLamports).toBe(4_500_000n);
      expect(c.toTreasuryLamports).toBe(2_250_000n);
      const xfers = chain.sent.filter((t) => t.kind === "xfer").map((t) => t.detail as { to: string; lamports: bigint }[]);
      expect(xfers).toEqual([[{ to: chain.wallets.treasury, lamports: 2_250_000n }]]);
    } finally {
      Object.assign(w, saved);
    }
  });

  it("holds the claim and pauses buybacks on a shortfall over 0.5%", async () => {
    chain.vault = 6_000_000n;
    await reconcileTick(ctx);
    await indexClaim();
    const c = await db.vaultClaim.findFirstOrThrow();
    expect(c.stage).toBe("held");
    expect(await getSetting(db, SETTING.buybacksPaused, false)).toBe(true);
    expect(alerts.map((a) => a.kind)).toContain("reconcile_mismatch");
  });

  it("sends a surplus to the treasury and keeps going (anyone can top up the public fee vault)", async () => {
    chain.vault = 8_000_000n;
    await reconcileTick(ctx);
    await indexClaim();
    const c = await db.vaultClaim.findFirstOrThrow();
    expect(c.stage).toBe("done");
    expect(c.toBuybackLamports).toBe(4_500_000n); // holders get exactly their accrued share
    expect(c.toTreasuryLamports).toBe(3_500_000n);
    expect(await getSetting(db, SETTING.buybacksPaused, false)).toBe(false);
    expect(alerts.map((a) => a.kind)).toContain("reconcile_surplus");
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
    expect((await checkInvariants(ctx)).tokenShortfalls).toEqual([]); // first sighting: re-check before pausing
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).payoutsPaused).toBe(false);
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
    expect((await checkInvariants(ctx)).solShortfall).toBeNull();
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

  it("charges the harvest's and the settlement's network fees to the holders' share (D-053)", async () => {
    chain.fee = 1_000n;
    await launchCoin();
    await db.coin.update({ where: { mint: MINT }, data: { status: "GRADUATED", cpmmPoolId: "CpmmPoo111111111111111111111111111111111111" } });
    expect(await harvestCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("harvested");
    const h = await db.harvest.findFirstOrThrow();
    expect(h.feeLamports).toBe(2_000n);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(4_500_000n + 200n - 2_000n);
    await settleHarvest(ctx, h.id); // re-checking a settled harvest charges nothing again
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(4_500_000n + 200n - 2_000n);
  });
});

/* ---------------------------- audit regressions ---------------------------- */

describe("audit: balances the mint stream can't see (C1)", () => {
  beforeEach(async () => {
    await launchCoin();
    await holders();
  });

  it("a round trip through an invisible transfer can't inflate a balance or dodge forfeiture", async () => {
    // Mallory (Bob) moves 1000 to a fresh wallet with a plain Transfer (invisible), then it comes back with
    // TransferChecked (visible). Recorded: Bob 2000, chain: Bob 1000.
    chain.invisible.set(`${MINT}|${BOB}`, -1000n);
    chain.invisible.set(`${MINT}|N111111111111111111111111111111111111111111`, 1000n);
    stream(MINT, [balanceTx("rt1", 20, t(-60), [{ owner: "N111111111111111111111111111111111111111111", delta: -1000n }, { owner: BOB, delta: 1000n }])]);
    chain.invisible.set(`${MINT}|N111111111111111111111111111111111111111111`, 0n);
    await indexMint(ctx, MINT, state);
    // the negative balance of N proved a missed inflow → synced right away in the same indexer pass
    const bob = await db.holderState.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: BOB } } });
    expect(bob.balance).toBe(1000n);
    expect(bob.mismatchAt).not.toBeNull();
    expect(bob.decreasedSincePayout).toBe(true);
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.needsHolderSync).toBe(false);
    expect(coin.holderSyncedAt).not.toBeNull();

    // and Bob earns nothing from the window the mismatch was found in
    await db.coin.update({ where: { mint: MINT }, data: { buybackBudget: 1_200_000_000n } });
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }));
    clock = new Date(clock.getTime() + 1000);
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }));
    const bb = await db.buyback.findFirstOrThrow();
    await creditBuyback(ctx, bb.id);
    const credits = await db.rewardCredit.findMany({ where: { buybackId: bb.id } });
    expect(credits.find((c) => c.wallet === BOB)).toBeUndefined();
    expect(credits.find((c) => c.wallet === ALICE)!.amount).toBeGreaterThan(0n);
  });

  it("a transfer in that the stream missed is picked up by the sync without penalty", async () => {
    chain.invisible.set(`${MINT}|${ALICE}`, 500n);
    await db.coin.update({ where: { mint: MINT }, data: { needsHolderSync: true } });
    await indexMint(ctx, MINT, state);
    const alice = await db.holderState.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: ALICE } } });
    expect(alice.balance).toBe(3500n);
    expect(alice.mismatchAt).toBeNull();
    expect(alice.decreasedSincePayout).toBe(false);
  });

  it("changes at or below the sync slot are already in the synced balance and are skipped", async () => {
    await db.coin.update({ where: { mint: MINT }, data: { needsHolderSync: true } });
    await indexMint(ctx, MINT, state); // sync at slot 12 (newest streamed)
    const late = balanceTx("late", 12, t(-1), [{ owner: ALICE, delta: 7n }]);
    stream(MINT, [late]); // an older transaction the stream only returns now
    chain.invisible.set(`${MINT}|${ALICE}`, -7n); // (chain truth already counted it at the sync)
    await indexMint(ctx, MINT, state);
    expect((await db.holderState.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: ALICE } } })).balance).toBe(3000n);
  });

  it("payouts wait for a holder sync after the round started", async () => {
    await db.pending.create({ data: { coinMint: MINT, wallet: ALICE, amount: 10_000_000_000n } });
    await db.coin.update({ where: { mint: MINT }, data: { mcapUsd: 150_000 } });
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(await payCoin(ctx, coin, 1)).toEqual([]);
    expect(await db.payout.count()).toBe(0);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).needsHolderSync).toBe(true);
    await indexMint(ctx, MINT, state);
    expect(await payCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }), 1)).toEqual([ALICE]);
  });

  it("a decrease recorded after the payout snapshot stays flagged", async () => {
    await db.coin.update({ where: { mint: MINT }, data: { holderSyncedAt: clock } });
    await db.holderState.updateMany({ where: { coinMint: MINT, wallet: BOB }, data: { decreasedSincePayout: true, lastDecreaseAt: new Date(clock.getTime() + 5_000) } });
    await db.holderState.updateMany({ where: { coinMint: MINT, wallet: CAROL }, data: { decreasedSincePayout: true, lastDecreaseAt: new Date(clock.getTime() - 5_000) } });
    await payCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }), 1);
    const flag = async (w: string) => (await db.holderState.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: w } } })).decreasedSincePayout;
    expect(await flag(BOB)).toBe(true);
    expect(await flag(CAROL)).toBe(false);
  });

  it("payout transfers carry the coin's decimals (TransferChecked)", async () => {
    await db.coin.update({ where: { mint: MINT }, data: { holderSyncedAt: clock, mcapUsd: 150_000 } });
    await db.pending.create({ data: { coinMint: MINT, wallet: ALICE, amount: 10_000_000_000n } });
    await payCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }), 1);
    expect((chain.sent.find((x) => x.kind === "pay")!.detail as { decimals: number }).decimals).toBe(6);
  });
});

describe("audit: indexer never skips or stalls (H1, H2, H4, poison pills)", () => {
  it("pages back through a backlog larger than one page and returns the oldest first", async () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ signature: "s" + (2499 - i), slot: 2499 - i, failed: false, blockTime: null })); // newest first
    const page = async (before: string | undefined) => {
      const start = before ? all.findIndex((x) => x.signature === before) + 1 : 0;
      return all.slice(start, start + 1000);
    };
    const got = await collectSignatures(page, 500);
    expect(got).toHaveLength(500);
    expect(got[0]!.signature).toBe("s0"); // oldest first, nothing between the cursor and the newest page skipped
    expect(got[499]!.signature).toBe("s499");
  });

  it("stops at a signature the RPC can't return yet and doesn't move the cursor past it", async () => {
    await launchCoin();
    stream(MINT, [balanceTx("u1", 20, t(-10), [{ owner: ALICE, delta: 10n }]), balanceTx("u2", 21, t(-5), [{ owner: ALICE, delta: 20n }])]);
    chain.unavailable.add("u1");
    expect(await indexMint(ctx, MINT, state)).toBe(0);
    const cur = await db.streamCursor.findUnique({ where: { stream: `mint:${MINT}` } });
    expect(cur?.signature ?? null).toBeNull();
    expect(cur?.stuckSignature).toBe("u1");
    chain.unavailable.clear();
    expect(await indexMint(ctx, MINT, state)).toBe(2);
    expect((await db.holderState.findUniqueOrThrow({ where: { coinMint_wallet: { coinMint: MINT, wallet: ALICE } } })).balance).toBe(30n);
  });

  it("sets a poison transaction aside after repeated failures instead of halting the stream", async () => {
    await launchCoin();
    const bad = tradeTx("poison", { slot: 30, time: t(-5), trader: BOB, platformFee: 1n });
    bad.trades[0]!.eventIndex = Number.NaN; // makes the DB write throw
    stream(chain.platformConfig, [bad, tradeTx("good", { slot: 31, time: t(-4), trader: BOB, platformFee: 3_000_000n })]);
    for (let i = 0; i < 4; i++) expect(await indexPlatform(ctx, state)).toBe(0);
    expect(await indexPlatform(ctx, state)).toBe(1); // 5th attempt: dead-lettered, then "good" applies
    expect(await db.indexerDeadLetter.count()).toBe(1);
    expect(alerts.map((a) => a.kind)).toContain("indexer_dead_letter");
    expect(await db.trade.count({ where: { signature: "good" } })).toBe(1);
  });

  it("hides lookalike tickers and Token-2022 coins from other frontends and keeps their buybacks off", async () => {
    const tx = tradeTx("t22", { slot: 10, time: t(-100), trader: ALICE, platformFee: 1n, create: true });
    tx.creates[0]!.tokenProgram = "token2022";
    tx.creates[0]!.event!.symbol = "МОСНI"; // Cyrillic lookalike
    stream(chain.platformConfig, [tx]);
    await indexPlatform(ctx, state);
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.hidden).toBe(true);
    expect(coin.tickerSlot).toBeNull();
    expect(coin.buybacksPaused).toBe(true);
    expect(coin.payoutsPaused).toBe(true);
  });

  it("graduates by mint even when the migration's pool account differs, and never downgrades", async () => {
    await launchCoin();
    stream(chain.platformConfig, [{ signature: "mig", slot: 40, blockTime: t(-3), failed: false, creates: [], trades: [], migrations: [{ mint: MINT, pool: "SomeOtherAccount111111111111111111111111111", cpmmPool: "Cpmm111111111111111111111111111111111111111", platformConfig: chain.platformConfig }], balanceChanges: [], warnings: [] }]);
    await indexPlatform(ctx, state);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).status).toBe("GRADUATED");
    const late = tradeTx("late", { slot: 41, time: t(-2), trader: BOB, platformFee: 1n });
    late.trades[0]!.poolStatus = 1;
    stream(chain.platformConfig, [late]);
    await indexPlatform(ctx, state);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).status).toBe("GRADUATED");
  });

  it("refuses to connect to hosts that resolve to private addresses", async () => {
    const lookup = guardedLookup((_h, cb) => cb(null, [{ address: "169.254.169.254", family: 4 }]));
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => lookup("meta.example", {}, (e) => r(e)));
    expect(err?.code).toBe("EPRIVATE");
    const ok = guardedLookup((_h, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]));
    const addr = await new Promise<string>((r) => ok("meta.example", {}, (_e, a) => r(a as string)));
    expect(addr).toBe("93.184.216.34");
  });
});

describe("audit: settlement only from readable effects (H3, L1, L4, L9)", () => {
  beforeEach(async () => {
    await launchCoin();
    await holders();
    await db.coin.update({ where: { mint: MINT }, data: { buybackBudget: 1_200_000_000n } });
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } })); // open the round
  });

  it("a landed buyback whose effects can't be read stays open, then settles correctly", async () => {
    chain.maxChunk = 400_000_000n;
    const orig = chain.prepareBuyback.bind(chain);
    chain.prepareBuyback = async (c, a, m) => {
      const p = await orig(c, a, m);
      chain.unreadable.add(p.signature);
      return p;
    };
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("bought");
    const row = await db.buyback.findFirstOrThrow({ where: { chunk: 0 } });
    expect(row.status).toBe("SENT"); // not CONFIRMED with 0 tokens
    chain.unreadable.clear();
    chain.statuses.set(row.signature!, "confirmed");
    await recoverInflight(ctx);
    const done = await db.buyback.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.status).toBe("CONFIRMED");
    expect(done.tokensBought).toBe(400_000_000n * chain.tokensPerLamport);
  });

  it("charges the network fee to the coin and returns SOL the program didn't take", async () => {
    chain.maxChunk = 400_000_000n;
    chain.fee = 5_000n;
    const orig = chain.prepareBuyback.bind(chain);
    chain.prepareBuyback = async (c, a, m) => {
      const p = await orig(c, a, m);
      const fx = chain.effects.get(p.signature)!;
      fx.lamportDeltas = { [chain.wallets.buyback]: -(a - 50_000_000n) - 5_000n }; // program took 50M less (curve completed)
      return p;
    };
    const before = (await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget;
    await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }));
    const bb = await db.buyback.findFirstOrThrow({ where: { chunk: 0 } });
    expect(bb.refundedLamports).toBe(50_000_000n - 5_000n);
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.buybackBudget).toBe(before - 400_000_000n + 50_000_000n - 5_000n);
    expect(coin.paidToHoldersLamports).toBe(400_000_000n - 49_995_000n);
  });

  it("a buyback that failed on chain refunds its budget minus the fee and waits before retrying", async () => {
    chain.fee = 5_000n;
    chain.outcomes = ["failed"];
    const before = (await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget;
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("failed");
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybackBudget).toBe(before - 5_000n);
    // spacing applies after a failure too
    expect(await stepCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("waiting");
  });
});

describe("audit: harvest", () => {
  it("backs off after a dust harvest and sends the platform share to the treasury", async () => {
    await launchCoin();
    await db.coin.update({ where: { mint: MINT }, data: { status: "GRADUATED", cpmmPoolId: "CpmmPoo111111111111111111111111111111111111" } });
    expect(await harvestCoin(ctx, await db.coin.findUniqueOrThrow({ where: { mint: MINT } }))).toBe("harvested");
    const settle = chain.sent.find((x) => x.kind === "settle")!.detail as { treasury: bigint };
    expect(settle.treasury).toBe(100n);
    const coin = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(coin.nextHarvestAt!.getTime()).toBeGreaterThan(clock.getTime()); // tokens were harvested → normal interval
    clock = new Date(clock.getTime() + 2 * 3600_000);
    await db.harvest.updateMany({ data: { createdAt: new Date(clock.getTime() - 2 * 3600_000) } });
  });
});

describe("audit: worker lease (L5)", () => {
  it("lets one owner hold a worker at a time and hands it over after expiry or release", async () => {
    expect(await acquireLease(db, "buyback", "a", 60_000)).toBe(true);
    expect(await acquireLease(db, "buyback", "b", 60_000)).toBe(false);
    expect(await acquireLease(db, "buyback", "a", 60_000)).toBe(true); // renew
    await releaseLease(db, "buyback", "a");
    expect(await acquireLease(db, "buyback", "b", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await acquireLease(db, "buyback", "c", 60_000)).toBe(true); // b's lease expired
  });
});

describe("audit: Jupiter instructions are checked before the buyback key signs (H5)", () => {
  const payer = Keypair.generate().publicKey;
  const dest = Keypair.generate().publicKey;
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer, true);
  const j = (programId: string, accounts: { pubkey: string; isSigner?: boolean; isWritable?: boolean }[], data: Buffer) => ({ programId, accounts: accounts.map((a) => ({ isSigner: false, isWritable: true, ...a })), data: data.toString("base64") });
  const swap = j(JUPITER_V6, [{ pubkey: payer.toBase58(), isSigner: true }, { pubkey: dest.toBase58() }], Buffer.from([1, 2, 3]));
  const wrap = SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsol, lamports: 100 });

  it("accepts a plain wrap + swap into the distributor", () => {
    const ixs = checkJupiterInstructions({ setupInstructions: [j(wrap.programId.toBase58(), wrap.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner })), wrap.data)], swapInstruction: swap }, payer, dest);
    expect(ixs).toHaveLength(2);
  });

  it("rejects a transfer out of the buyback wallet, foreign programs and foreign signers", () => {
    const drain = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 10 ** 9 });
    expect(() => checkJupiterInstructions({ setupInstructions: [j(drain.programId.toBase58(), drain.keys.map((k) => ({ pubkey: k.pubkey.toBase58() })), drain.data)], swapInstruction: swap }, payer, dest)).toThrow(/system/);
    expect(() => checkJupiterInstructions({ swapInstruction: j(Keypair.generate().publicKey.toBase58(), [{ pubkey: dest.toBase58() }], Buffer.from([0])) }, payer, dest)).toThrow(/not allowed/);
    expect(() => checkJupiterInstructions({ swapInstruction: j(JUPITER_V6, [{ pubkey: new PublicKey(dest).toBase58() }, { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: true }], Buffer.from([0])) }, payer, dest)).toThrow(/signer/);
    expect(() => checkJupiterInstructions({ swapInstruction: j(JUPITER_V6, [{ pubkey: payer.toBase58() }], Buffer.from([0])) }, payer, dest)).toThrow(/distributor/);
  });
});
