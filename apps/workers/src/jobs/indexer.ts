/**
 * Indexer (SPEC §6.1). Two kinds of streams, each restart-safe with a cursor
 * written in the same DB transaction as the effects:
 *
 *  - "platform:<PlatformConfig>": every launch, trade and migration under our
 *    platform (all of them reference the PlatformConfig account). Writes Coin,
 *    Trade, FeeAccrual (+ buyback budget), Candle, curve state.
 *  - "mint:<mint>": every transaction touching a coin's mint, in order. Writes
 *    BalanceEvent and HolderState (TWAB and forfeiture come from these), and
 *    CPMM trades after graduation.
 */
import {
  CURVE,
  META_LIMITS,
  TF_SECONDS,
  candleOpen,
  cleanMetadata,
  cleanText,
  curveMcapUsd,
  isPlainTicker,
  priceLamportsPerToken,
  splitPlatformFee,
  tickerKey,
  type CurveState,
  type LiveEvent,
} from "@backflow/core";
import type { BalanceChange, ParsedLaunchLabTx, ParsedTrade } from "@backflow/chain";
import { Prisma, coinRow } from "@backflow/db";
import { ipfsGateway } from "../chain";
import type { Ctx } from "../ctx";
import { jobLog, sec } from "../ctx";

/** Attempts before a signature that keeps failing to apply is set aside (dead letter) instead of stalling its stream. */
export const MAX_APPLY_ATTEMPTS = 5;
/** How long a stream may wait on an unfetchable signature before alerting. */
const STUCK_ALERT_MS = 5 * 60_000;
const METADATA_MAX_ATTEMPTS = 5;

const WSOL = "So11111111111111111111111111111111111111112";

export interface IndexerState {
  solUsd: number | null;
}

type Tx = Prisma.TransactionClient;

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2_147_483_647;
}

async function cursor(db: Ctx["db"], stream: string) {
  return db.streamCursor.findUnique({ where: { stream } });
}

const mcapOf = (s: CurveState, solUsd: number | null) => curveMcapUsd(s, CURVE.supplyBaseUnits, solUsd);

async function upsertCandles(tx: Tx, mint: string, t: number, mcap: number, volLamports: bigint, buyback: boolean) {
  for (const [tf, secs] of Object.entries(TF_SECONDS)) {
    const openTime = new Date(candleOpen(t, secs) * 1000);
    const v = new Prisma.Decimal(mcap.toFixed(2));
    const ex = await tx.candle.findUnique({ where: { coinMint_tf_openTime: { coinMint: mint, tf, openTime } } });
    if (!ex) {
      // open at the previous close so candles connect
      const prev = await tx.candle.findFirst({ where: { coinMint: mint, tf, openTime: { lt: openTime } }, orderBy: { openTime: "desc" } });
      const o = prev ? prev.c : v;
      await tx.candle.create({ data: { coinMint: mint, tf, openTime, o, h: Prisma.Decimal.max(o, v), l: Prisma.Decimal.min(o, v), c: v, volLamports, hasBuyback: buyback } });
    } else {
      await tx.candle.update({
        where: { coinMint_tf_openTime: { coinMint: mint, tf, openTime } },
        data: { h: Prisma.Decimal.max(ex.h, v), l: Prisma.Decimal.min(ex.l, v), c: v, volLamports: ex.volLamports + volLamports, hasBuyback: ex.hasBuyback || buyback },
      });
    }
  }
}

/* --------------------------------- platform -------------------------------- */

/** Apply one parsed platform transaction. Idempotent (primary keys), returns live events to publish after commit. */
export async function applyPlatformTx(ctx: Ctx, tx: Tx, p: ParsedLaunchLabTx, state: IndexerState): Promise<LiveEvent[]> {
  const events: LiveEvent[] = [];
  if (p.failed) return events;
  const blockTime = new Date((p.blockTime ?? sec(ctx.now())) * 1000);

  for (const c of p.creates) {
    if (c.platformConfig !== ctx.chain.platformConfig) continue;
    if (await tx.coin.findUnique({ where: { mint: c.mint } })) continue;
    const ev = c.event;
    const pool = ev ? null : await ctx.chain.launchPool(c.pool);
    // Everything in the event is untrusted: anyone can launch under our PlatformConfig from any frontend.
    const symbol = cleanText(ev?.symbol, META_LIMITS.symbol);
    const name = cleanText(ev?.name, META_LIMITS.name) || symbol;
    const uri = typeof ev?.uri === "string" && ev.uri.length <= 200 ? ev.uri.trim() : "";
    const key = tickerKey(symbol);
    const taken = await tx.coin.findUnique({ where: { tickerSlot: key } });
    const intent = await tx.launchIntent.findUnique({ where: { mint: c.mint } });
    // Hidden until a moderator looks: duplicate tickers, lookalike/unicode tickers, Token-2022 mints (payouts can't serve them).
    const hideReason = taken
      ? "duplicate ticker $" + symbol.toUpperCase()
      : !isPlainTicker(symbol)
        ? "ticker needs review (not plain letters and digits)"
        : c.tokenProgram === "token2022"
          ? "Token-2022 coins aren't supported"
          : null;
    const supply = ev?.supply ?? pool?.supply ?? CURVE.supplyBaseUnits;
    const totalSell = ev?.totalBaseSell ?? pool?.totalSellA ?? CURVE.sellOnCurveBaseUnits;
    const fundRaising = ev?.totalQuoteFundRaising ?? pool?.totalFundRaisingB ?? CURVE.graduationTargetLamports;
    const fresh = pool ?? (await ctx.chain.launchPool(c.pool));
    const coin = await tx.coin.create({
      data: {
        mint: c.mint,
        poolId: c.pool,
        platformConfig: c.platformConfig,
        name: name.slice(0, 64),
        ticker: symbol.toUpperCase().slice(0, 16),
        tickerKey: key,
        tickerSlot: hideReason ? null : key,
        hidden: !!hideReason,
        hiddenReason: hideReason,
        launchedViaUs: !!intent,
        metadataUri: uri || null,
        metadataStatus: uri ? "pending" : "ok", // fetched by fillMetadata, outside this transaction
        tokenProgram: c.tokenProgram,
        buybacksPaused: c.tokenProgram === "token2022",
        payoutsPaused: c.tokenProgram === "token2022",
        avatarSeed: hashSeed(c.mint),
        creator: c.creator,
        decimals: ev?.decimals ?? fresh?.decimalsA ?? CURVE.decimals,
        supply,
        graduationTargetLamports: fundRaising,
        virtualBase: fresh?.virtualA ?? 0n,
        virtualQuote: fresh?.virtualB ?? 0n,
        realBase: 0n,
        realQuote: 0n,
        createdAt: blockTime,
        lastDistributionAt: blockTime,
      },
    });
    void totalSell;
    if (intent) await tx.launchIntent.delete({ where: { mint: c.mint } });
    if (!coin.hidden) events.push({ type: "coin_created", coin: coinRow(coin, []) });
  }

  for (const t of p.trades) {
    const coin = await tx.coin.findUnique({ where: { poolId: t.poolState } });
    if (!coin) continue;
    const exists = await tx.trade.findUnique({ where: { signature_eventIndex: { signature: p.signature, eventIndex: t.eventIndex } } });
    if (exists) continue;
    const ev = await applyCurveTrade(ctx, tx, coin.mint, coin.status, p, t, blockTime, state);
    events.push(...ev);
  }

  for (const m of p.migrations) {
    if (m.platformConfig !== ctx.chain.platformConfig) continue;
    const coin = await tx.coin.findFirst({ where: { OR: [{ poolId: m.pool }, { mint: m.mint }] } });
    if (!coin || coin.status === "GRADUATED") continue;
    await tx.coin.update({ where: { mint: coin.mint }, data: { status: "GRADUATED", cpmmPoolId: m.cpmmPool, graduatedAt: blockTime } });
    events.push({ type: "graduated", mint: coin.mint, cpmmPoolId: m.cpmmPool });
  }
  return events;
}

async function applyCurveTrade(ctx: Ctx, tx: Tx, mint: string, status: string, p: ParsedLaunchLabTx, t: ParsedTrade, blockTime: Date, state: IndexerState): Promise<LiveEvent[]> {
  const isBuy = t.direction === "buy";
  const fees = t.protocolFee + t.platformFee + t.creatorFee + t.shareFee;
  const quoteGross = isBuy ? t.amountIn : t.amountOut + fees;
  const tokenAmount = isBuy ? t.amountOut : t.amountIn;
  const wallet = t.trader ?? "unknown";
  const isBuyback = wallet === ctx.chain.wallets.buyback;
  await tx.trade.create({
    data: {
      signature: p.signature,
      eventIndex: t.eventIndex,
      coinMint: mint,
      wallet,
      side: isBuy ? "BUY" : "SELL",
      quoteLamports: quoteGross,
      tokenAmount,
      platformFee: t.platformFee,
      creatorFee: t.creatorFee,
      protocolFee: t.protocolFee,
      feeExact: true,
      isBuyback,
      venue: "CURVE",
      slot: BigInt(p.slot),
      blockTime,
    },
  });
  const split = splitPlatformFee(t.platformFee);
  await tx.feeAccrual.create({
    data: { tradeSignature: p.signature, tradeEventIndex: t.eventIndex, coinMint: mint, platformFee: t.platformFee, holdersPart: split.holders, platformPart: split.platform },
  });
  const curve: CurveState = { virtualBase: t.virtualBase, virtualQuote: t.virtualQuote, realBase: t.realBaseAfter, realQuote: t.realQuoteAfter, totalSellBase: t.totalBaseSell };
  const mcap = mcapOf(curve, state.solUsd);
  const updated = await tx.coin.update({
    where: { mint },
    data: {
      virtualBase: t.virtualBase,
      virtualQuote: t.virtualQuote,
      realBase: t.realBaseAfter,
      realQuote: t.realQuoteAfter,
      curveQuoteLamports: t.realQuoteAfter,
      priceLamportsPerToken: new Prisma.Decimal(priceLamportsPerToken(curve)),
      ...(mcap != null ? { mcapUsd: new Prisma.Decimal(mcap.toFixed(2)) } : {}),
      buybackBudget: { increment: split.holders },
      status: t.poolStatus === 1 && status === "CURVE" ? "MIGRATING" : undefined, // never downgrade GRADUATED
      lastSlot: BigInt(p.slot),
    },
  });
  if (mcap != null) await upsertCandles(tx, mint, Math.floor(blockTime.getTime() / 1000), mcap, quoteGross, isBuyback);
  return [
    {
      type: "trade",
      mint,
      trade: { signature: p.signature, wallet, side: isBuy ? "buy" : "sell", quoteLamports: quoteGross.toString(), tokenAmount: tokenAmount.toString(), blockTime: blockTime.toISOString(), isBuyback },
    },
    {
      type: "price",
      mint,
      mcapUsd: mcap,
      priceUsd: mcap != null ? mcap / Number(CURVE.supplyTokens) : null,
      priceLamports: priceLamportsPerToken(curve),
      change24hPct: Number(updated.change24hPct),
      vol24hUsd: Number(updated.vol24hUsd),
      curveQuoteLamports: t.realQuoteAfter.toString(),
      holderCount: updated.holderCount,
      t: blockTime.getTime(),
    },
    { type: "vault", mint, buybackBudgetLamports: updated.buybackBudget.toString() },
  ];
}

type Sig = { signature: string; slot: number; failed: boolean; blockTime: number | null };

/**
 * Shared stream loop. Rules (CLAUDE.md rule 5):
 *  - a signature that didn't fail but can't be fetched yet stops the stream right there (cursor not
 *    moved); it is retried next tick and alerts if it stays stuck;
 *  - effects and the cursor move are written in one transaction;
 *  - a signature whose effects keep failing to apply is recorded as a dead letter after
 *    MAX_APPLY_ATTEMPTS and the stream moves on (so one poison transaction can't halt indexing).
 */
async function runStream(ctx: Ctx, stream: string, sigs: Sig[], apply: (tx: Tx, p: ParsedLaunchLabTx) => Promise<LiveEvent[]>): Promise<number> {
  let n = 0;
  for (const s of sigs) {
    let parsed: ParsedLaunchLabTx | null = null;
    if (!s.failed) {
      parsed = await ctx.chain.parsedTx(s.signature);
      if (!parsed) {
        await markStuck(ctx, stream, s, "transaction not returned by the RPC yet");
        return n;
      }
      if (parsed.blockTime == null) parsed.blockTime = (await ctx.chain.blockTime(parsed.slot)) ?? s.blockTime;
      if (parsed.warnings.length) await jobLog(ctx.db, "indexer", "warn", parsed.warnings.join("; ").slice(0, 900), s.signature);
    }
    const move = { slot: BigInt(s.slot), signature: s.signature, stuckSignature: null, stuckSince: null, stuckAttempts: 0 };
    let events: LiveEvent[];
    try {
      events = await ctx.db.$transaction(
        async (tx) => {
          const ev = parsed ? await apply(tx, parsed) : [];
          await tx.streamCursor.upsert({ where: { stream }, create: { stream, ...move }, update: move });
          return ev;
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      const attempts = await markStuck(ctx, stream, s, (e as Error).message);
      if (attempts < MAX_APPLY_ATTEMPTS) return n;
      await ctx.db.$transaction([
        ctx.db.indexerDeadLetter.upsert({
          where: { stream_signature: { stream, signature: s.signature } },
          create: { stream, signature: s.signature, error: (e as Error).message.slice(0, 1000), attempts },
          update: { error: (e as Error).message.slice(0, 1000), attempts },
        }),
        ctx.db.streamCursor.upsert({ where: { stream }, create: { stream, ...move }, update: move }),
      ]);
      await ctx.alerts.alert("indexer_dead_letter", `could not apply ${s.signature} on ${stream} after ${attempts} attempts; set aside for replay`, { stream, signature: s.signature });
      continue;
    }
    for (const e of events) await ctx.live.publish(e);
    n++;
  }
  return n;
}

/** Record that a stream is waiting on a signature; returns the attempt count for that signature. */
async function markStuck(ctx: Ctx, stream: string, s: Sig, reason: string): Promise<number> {
  const cur = await cursor(ctx.db, stream);
  const same = cur?.stuckSignature === s.signature;
  const attempts = same ? (cur?.stuckAttempts ?? 0) + 1 : 1;
  const since = same && cur?.stuckSince ? cur.stuckSince : ctx.now();
  await ctx.db.streamCursor.upsert({
    where: { stream },
    // a brand-new stream starts just before the stuck signature (slot only; the RPC cursor stays unset)
    create: { stream, slot: BigInt(Math.max(0, s.slot - 1)), signature: null, stuckSignature: s.signature, stuckSince: since, stuckAttempts: attempts },
    update: { stuckSignature: s.signature, stuckSince: since, stuckAttempts: attempts },
  });
  if (ctx.now().getTime() - since.getTime() > STUCK_ALERT_MS) await ctx.alerts.alert("indexer_stuck", `${stream} is waiting on ${s.signature}: ${reason}`, { stream, signature: s.signature });
  return attempts;
}

/** Process new platform-stream transactions. Returns how many were applied. */
export async function indexPlatform(ctx: Ctx, state: IndexerState, max = 500): Promise<number> {
  const stream = `platform:${ctx.chain.platformConfig}`;
  const cur = await cursor(ctx.db, stream);
  const sigs = await ctx.chain.signaturesSince(ctx.chain.platformConfig, cur?.signature ?? null, max);
  return runStream(ctx, stream, sigs, (tx, p) => applyPlatformTx(ctx, tx, p, state));
}

/**
 * Coin metadata (description, image, links) is fetched outside every DB transaction, with strict
 * limits (safe-fetch.ts), and validated before it is stored (cleanMetadata). Gives up after a few tries.
 */
export async function fillMetadata(ctx: Ctx, limit = 10): Promise<number> {
  const coins = await ctx.db.coin.findMany({ where: { metadataStatus: "pending", metadataAttempts: { lt: METADATA_MAX_ATTEMPTS } }, orderBy: { createdAt: "asc" }, take: limit });
  let n = 0;
  for (const c of coins) {
    const raw = c.metadataUri ? await ctx.chain.tokenMetadata(c.metadataUri) : null;
    if (raw == null) {
      const attempts = c.metadataAttempts + 1;
      await ctx.db.coin.update({ where: { mint: c.mint }, data: { metadataAttempts: attempts, ...(attempts >= METADATA_MAX_ATTEMPTS ? { metadataStatus: "failed" } : {}) } });
      continue;
    }
    const m = cleanMetadata(raw, ipfsGateway());
    await ctx.db.coin.update({ where: { mint: c.mint }, data: { ...m, metadataStatus: "ok", metadataAttempts: c.metadataAttempts + 1 } });
    n++;
  }
  return n;
}

/* ----------------------------------- mints ---------------------------------- */

/**
 * Apply token balance changes for one coin from one transaction.
 * The mint stream can't see every transfer (a plain SPL Transfer doesn't list the mint), so balances
 * here are corrected by syncHolders. A balance that would go negative proves a missed inflow: it is
 * stored as 0 and the coin is queued for a sync. Changes at or below the last sync slot are already
 * part of the synced balance and are skipped.
 */
export async function applyBalanceChanges(ctx: Ctx, tx: Tx, mint: string, p: { signature: string; slot: number; blockTime: number | null; balanceChanges: BalanceChange[] }, state: IndexerState): Promise<LiveEvent[]> {
  const blockTime = new Date((p.blockTime ?? sec(ctx.now())) * 1000);
  const changes = p.balanceChanges.filter((c) => c.mint === mint);
  const coin = await tx.coin.findUnique({ where: { mint }, select: { holderSyncSlot: true } });
  const synced = coin != null && BigInt(p.slot) <= coin.holderSyncSlot;
  let negative = false;
  for (const c of synced ? [] : changes) {
    if (c.programOwned) continue;
    const dup = await tx.balanceEvent.findUnique({ where: { signature_coinMint_wallet: { signature: p.signature, coinMint: mint, wallet: c.owner } } });
    if (dup) continue;
    const hs = await tx.holderState.findUnique({ where: { coinMint_wallet: { coinMint: mint, wallet: c.owner } } });
    const raw = (hs?.balance ?? 0n) + c.delta;
    if (raw < 0n) negative = true;
    const balance = raw < 0n ? 0n : raw;
    const dec = c.delta < 0n ? { decreasedSincePayout: true, lastDecreaseAt: ctx.now() } : {};
    await tx.balanceEvent.create({ data: { coinMint: mint, wallet: c.owner, delta: c.delta, balance, signature: p.signature, slot: BigInt(p.slot), blockTime } });
    await tx.holderState.upsert({
      where: { coinMint_wallet: { coinMint: mint, wallet: c.owner } },
      create: { coinMint: mint, wallet: c.owner, balance, lastChangeAt: blockTime, ...dec },
      update: { balance, lastChangeAt: blockTime, ...dec },
    });
  }
  if (negative) await tx.coin.update({ where: { mint }, data: { needsHolderSync: true } });
  return detectCpmmTrade(ctx, tx, mint, p, changes, blockTime, state);
}

/**
 * Resync every holder's balance of a coin from chain (all token accounts of the mint). Runs in the
 * indexer process only, right after that coin's mint stream, so it is the single writer of balances.
 *  - stored balance below the real one: corrected (a transfer in that the stream couldn't see);
 *  - stored balance above the real one: corrected, the wallet is flagged as decreased (forfeiture)
 *    and marked mismatchAt, which excludes it from the buyback distribution of the current window.
 * Returns null when the chain read failed.
 */
export async function syncHolders(ctx: Ctx, mint: string): Promise<{ changed: number; over: string[] } | null> {
  const res = await ctx.chain.holderBalances(mint);
  if (!res) return null;
  const at = ctx.now();
  const real = new Map(res.holdings.filter((h) => !h.programOwned).map((h) => [h.owner, h.amount]));
  return ctx.db.$transaction(
    async (tx) => {
      const rows = await tx.holderState.findMany({ where: { coinMint: mint, OR: [{ balance: { gt: 0n } }, { wallet: { in: [...real.keys()] } }] } });
      const stored = new Map(rows.map((r) => [r.wallet, r.balance]));
      const over: string[] = [];
      let changed = 0;
      for (const wallet of new Set([...stored.keys(), ...real.keys()])) {
        const db = stored.get(wallet) ?? 0n;
        const chain = real.get(wallet) ?? 0n;
        if (db === chain) continue;
        changed++;
        const down = chain < db;
        if (down) over.push(wallet);
        await tx.balanceEvent.create({ data: { coinMint: mint, wallet, delta: chain - db, balance: chain, signature: "sync:" + res.slot + ":" + at.getTime(), slot: BigInt(res.slot), blockTime: at } });
        const flags = down ? { decreasedSincePayout: true, lastDecreaseAt: at, mismatchAt: at } : {};
        await tx.holderState.upsert({
          where: { coinMint_wallet: { coinMint: mint, wallet } },
          create: { coinMint: mint, wallet, balance: chain, lastChangeAt: at, ...flags },
          update: { balance: chain, lastChangeAt: at, ...flags },
        });
      }
      await tx.coin.update({ where: { mint }, data: { needsHolderSync: false, holderSyncedAt: at, holderSyncSlot: BigInt(res.slot) } });
      return { changed, over };
    },
    { timeout: 60_000 },
  );
}

/** After graduation, record pool swaps (wallet ↔ CPMM vault) as trades for volume and candles. */
async function detectCpmmTrade(ctx: Ctx, tx: Tx, mint: string, p: { signature: string; slot: number; balanceChanges: BalanceChange[] }, changes: BalanceChange[], blockTime: Date, state: IndexerState): Promise<LiveEvent[]> {
  const coin = await tx.coin.findUnique({ where: { mint } });
  if (!coin || coin.status !== "GRADUATED") return [];
  const poolSide = changes.find((c) => c.programOwned);
  const wallets = changes.filter((c) => !c.programOwned);
  const solPool = p.balanceChanges.find((c) => c.mint === WSOL && c.programOwned);
  if (!poolSide || !solPool || wallets.length !== 1) return [];
  const w = wallets[0]!;
  const isBuy = w.delta > 0n;
  const quote = solPool.delta < 0n ? -solPool.delta : solPool.delta;
  const token = w.delta < 0n ? -w.delta : w.delta;
  const exists = await tx.trade.findUnique({ where: { signature_eventIndex: { signature: p.signature, eventIndex: 0 } } });
  if (exists) return [];
  const isBuyback = w.owner === ctx.chain.wallets.distributor;
  await tx.trade.create({
    data: { signature: p.signature, eventIndex: 0, coinMint: mint, wallet: w.owner, side: isBuy ? "BUY" : "SELL", quoteLamports: quote, tokenAmount: token, platformFee: 0n, creatorFee: 0n, protocolFee: 0n, feeExact: false, isBuyback, venue: "CPMM", slot: BigInt(p.slot), blockTime },
  });
  const mcap = Number(coin.mcapUsd);
  if (mcap > 0) await upsertCandles(tx, mint, Math.floor(blockTime.getTime() / 1000), mcap, quote, isBuyback);
  void state;
  return [{ type: "trade", mint, trade: { signature: p.signature, wallet: w.owner, side: isBuy ? "buy" : "sell", quoteLamports: quote.toString(), tokenAmount: token.toString(), blockTime: blockTime.toISOString(), isBuyback } }];
}

/** Process the mint stream of one coin, then resync its holders from chain if a sync was requested. */
export async function indexMint(ctx: Ctx, mint: string, state: IndexerState, max = 500): Promise<number> {
  const stream = `mint:${mint}`;
  const cur = await cursor(ctx.db, stream);
  const sigs = await ctx.chain.signaturesSince(mint, cur?.signature ?? null, max);
  const n = await runStream(ctx, stream, sigs, (tx, p) => applyBalanceChanges(ctx, tx, mint, p, state));
  const coin = await ctx.db.coin.findUnique({ where: { mint }, select: { needsHolderSync: true } });
  if (coin?.needsHolderSync) {
    const r = await syncHolders(ctx, mint);
    if (r?.over.length) await jobLog(ctx.db, "indexer", "warn", `holder sync: ${r.over.length} wallets held less than recorded (missed outflows); flagged`, mint);
  }
  return n;
}

/** Index every coin's mint stream (bounded concurrency). */
export async function indexAllMints(ctx: Ctx, state: IndexerState, concurrency = 4): Promise<number> {
  const coins = await ctx.db.coin.findMany({ select: { mint: true }, orderBy: { lastSlot: "desc" } });
  let total = 0;
  for (let i = 0; i < coins.length; i += concurrency) {
    const counts = await Promise.all(coins.slice(i, i + concurrency).map((c) => indexMint(ctx, c.mint, state)));
    total += counts.reduce((a, b) => a + b, 0);
  }
  return total;
}

/* ----------------------------------- stats ---------------------------------- */

/** 24h volume, change and holder counts (SPEC §5 board columns). */
export async function refreshStats(ctx: Ctx, state: IndexerState, excluded: (mint: string) => Promise<Set<string>>): Promise<void> {
  const now = ctx.now();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const coins = await ctx.db.coin.findMany();
  for (const c of coins) {
    const vol = await ctx.db.trade.aggregate({ where: { coinMint: c.mint, blockTime: { gte: dayAgo } }, _sum: { quoteLamports: true } });
    const volUsd = state.solUsd != null ? (Number(vol._sum.quoteLamports ?? 0n) / 1e9) * state.solUsd : 0;
    const old = await ctx.db.candle.findFirst({ where: { coinMint: c.mint, tf: "1m", openTime: { lte: dayAgo } }, orderBy: { openTime: "desc" } });
    const first = old ?? (await ctx.db.candle.findFirst({ where: { coinMint: c.mint, tf: "1m" }, orderBy: { openTime: "asc" } }));
    let mcap = Number(c.mcapUsd);
    if (c.status !== "GRADUATED" && state.solUsd != null) {
      const m = mcapOf({ virtualBase: c.virtualBase, virtualQuote: c.virtualQuote, realBase: c.realBase, realQuote: c.realQuote, totalSellBase: CURVE.sellOnCurveBaseUnits }, state.solUsd);
      if (m != null) mcap = m;
    } else if (c.status === "GRADUATED" && state.solUsd != null) {
      // after graduation the price comes from the latest pool swap (lamports per base unit × supply)
      const last = await ctx.db.trade.findFirst({ where: { coinMint: c.mint, venue: "CPMM", tokenAmount: { gt: 0n } }, orderBy: [{ slot: "desc" }] });
      if (last) mcap = (Number(last.quoteLamports) / Number(last.tokenAmount)) * (Number(c.supply) / 1e9) * state.solUsd;
    }
    const change = first && Number(first.o) > 0 ? (mcap / Number(first.o) - 1) * 100 : 0;
    const ex = await excluded(c.mint);
    const holderCount = await ctx.db.holderState.count({ where: { coinMint: c.mint, balance: { gt: 0n }, wallet: { notIn: [...ex] } } });
    await ctx.db.coin.update({
      where: { mint: c.mint },
      data: { vol24hUsd: new Prisma.Decimal(volUsd.toFixed(2)), change24hPct: new Prisma.Decimal(change.toFixed(4)), mcapUsd: new Prisma.Decimal(mcap.toFixed(2)), holderCount },
    });
    await ctx.live.publish({
      type: "price",
      mint: c.mint,
      mcapUsd: mcap,
      priceUsd: mcap / Number(CURVE.supplyTokens),
      priceLamports: c.priceLamportsPerToken.toString(),
      change24hPct: change,
      vol24hUsd: volUsd,
      curveQuoteLamports: c.curveQuoteLamports.toString(),
      holderCount,
      t: now.getTime(),
    });
  }
}
