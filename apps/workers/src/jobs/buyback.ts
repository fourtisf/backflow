/**
 * Buyback worker (SPEC §3.1) and crediting (SPEC §3.2).
 *
 * Every buyback chunk is a row that moves pending → sent → confirmed|failed.
 * The budget is debited when the row is created and refunded if it fails, so a
 * crash at any point can be recovered from the row and the chain (CLAUDE.md
 * rule 5). The signature is stored before broadcasting, and a stored signature
 * is always checked before anything is retried.
 */
import { FEES, atLeastZero, distribute, minOutWithSlippage, nextBuybackStep, twabWeights, type HolderHistory } from "@backflow/core";
import { Prisma, buybackDto, type Buyback, type Coin } from "@backflow/db";
import type { CoinRef } from "../chain";
import { SETTING, excludedFor, getSetting, jobLog, sec, type Ctx } from "../ctx";

/** SOL kept in the buyback wallet for fees and rent. */
export const BUYBACK_FEE_RESERVE = 10_000_000n;
/** Rent of a token account the buy may close, plus rounding. */
const REFUND_TOLERANCE = 3_000_000n;
const UNCREDITED_ALERT_MS = 10 * 60_000;
/** A SENT buyback whose effects still can't be read after this long raises an alert (it is never settled as zero). */
const UNREADABLE_ALERT_MS = 10 * 60_000;

const refOf = (c: Coin): CoinRef => ({ mint: c.mint, poolId: c.poolId, cpmmPoolId: c.cpmmPoolId, graduated: c.status === "GRADUATED" });

export async function buybackTick(ctx: Ctx): Promise<void> {
  await recoverInflight(ctx);
  await creditConfirmed(ctx);
  if (await getSetting(ctx.db, SETTING.buybacksPaused, false)) return;
  if (await harvestWsolInFlight(ctx)) return;
  const coins = await ctx.db.coin.findMany({
    where: {
      buybacksPaused: false,
      status: { in: ["CURVE", "GRADUATED"] },
      NOT: { tokenProgram: "token2022" },
      OR: [{ buybackBudget: { gte: FEES.buyback.thresholdLamports } }, { roundRemainingLamports: { gt: 0n } }],
    },
    orderBy: { buybackBudget: "desc" },
  });
  for (const c of coins) {
    try {
      await stepCoin(ctx, c);
    } catch (e) {
      ctx.log.error({ err: e, mint: c.mint }, "buyback step failed");
      await jobLog(ctx.db, "buyback", "error", (e as Error).message, c.mint);
    }
  }
}

/**
 * With one server wallet (D-045) a harvest leaves its SOL as wSOL in the same token account every buy wraps
 * into and closes. A buy landing between the harvest and its settle would unwrap that SOL and book it as a
 * refund (audit). So no buyback runs while a harvest is in flight or unsettled.
 */
async function harvestWsolInFlight(ctx: Ctx): Promise<boolean> {
  const w = ctx.chain.wallets;
  if (w.buyback !== w.claim && w.buyback !== w.lockNft) return false;
  return (await ctx.db.harvest.count({ where: { OR: [{ status: { in: ["PENDING", "SENT"] } }, { status: "CONFIRMED", settled: false }] } })) > 0;
}

/**
 * Holders' SOL of this coin that hasn't reached the server wallet yet: fees still in the fee vault, or
 * claimed but not through the claim's transfer. A buyback may only spend budget whose SOL has arrived,
 * so it never spends the platform's share in transit or the wallet's working SOL (audit).
 */
export async function unarrivedHolderSol(ctx: Pick<Ctx, "db">, mint: string): Promise<bigint> {
  const r = await ctx.db.feeAccrual.aggregate({ where: { coinMint: mint, OR: [{ claimId: null }, { claim: { stage: { not: "done" } } }] }, _sum: { holdersPart: true } });
  return r._sum.holdersPart ?? 0n;
}

/** SOL in the server wallet that belongs to claims still being split (their treasury share is not out yet). */
async function openClaimSol(ctx: Ctx): Promise<bigint> {
  const r = await ctx.db.vaultClaim.aggregate({ where: { status: "CONFIRMED", stage: { not: "done" } }, _sum: { claimedLamports: true } });
  return r._sum.claimedLamports ?? 0n;
}

/** One decision for one coin: open a round, buy a chunk, or wait. */
export async function stepCoin(ctx: Ctx, c: Coin): Promise<"opened" | "bought" | "failed" | "waiting"> {
  const blocking = await ctx.db.buyback.findFirst({ where: { coinMint: c.mint, OR: [{ status: { in: ["PENDING", "SENT"] } }, { status: "CONFIRMED", credited: false }] } });
  if (blocking) return "waiting";
  const now = ctx.now();
  // spacing counts from the last chunk OR the last failed attempt, so a coin whose buys keep failing doesn't retry every tick
  const lastTry = [c.lastBuybackAt, c.lastBuybackAttemptAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  const since = lastTry ? (now.getTime() - lastTry.getTime()) / 1000 : Number.MAX_SAFE_INTEGER;
  const budget = c.buybackBudget - (await unarrivedHolderSol(ctx, c.mint)); // only SOL that has arrived
  const base = { budget, roundRemaining: c.roundRemainingLamports, secondsSinceLastChunk: since };

  const first = nextBuybackStep({ ...base, maxChunk: budget });
  if (first.action === "open_round") {
    const r = await ctx.db.coin.updateMany({ where: { mint: c.mint, roundRemainingLamports: 0n }, data: { buybackRound: { increment: 1 }, roundRemainingLamports: first.roundSize } });
    return r.count ? "opened" : "waiting";
  }
  if (first.action === "wait") return "waiting";

  if (budget <= 0n) return "waiting"; // nothing arrived yet, or payout fees left it negative (D-049)
  const plan = await ctx.chain.buybackPlan(refOf(c), FEES.buyback.maxImpactBps);
  if (!plan) return "waiting";
  const cap = c.roundRemainingLamports < budget ? c.roundRemainingLamports : budget;
  const step = nextBuybackStep({ ...base, maxChunk: plan.maxChunk(cap) });
  if (step.action !== "buy") return "waiting";
  const amount = step.amount;

  // the platform's share of a claim that is still being split sits in the same wallet: never spend it
  const sol = (await ctx.chain.solBalance(ctx.chain.wallets.buyback)) - (await openClaimSol(ctx));
  if (sol < amount + BUYBACK_FEE_RESERVE) {
    await ctx.alerts.alert("low_balance", `buyback wallet has ${sol} lamports, needs ${amount + BUYBACK_FEE_RESERVE} for ${c.ticker}`, { mint: c.mint });
    return "waiting";
  }
  const expected = plan.expectedOut(amount);
  // SPEC §3.1: slippage bound from the quote, so a front-runner can't take more than the impact cap.
  const minOut = minOutWithSlippage(expected, FEES.buyback.maxImpactBps);
  const chunk = await ctx.db.buyback.count({ where: { coinMint: c.mint, round: c.buybackRound } });

  const row = await ctx.db.$transaction(async (tx) => {
    const debit = await tx.coin.updateMany({
      where: { mint: c.mint, buybackBudget: { gte: amount }, roundRemainingLamports: { gte: amount } },
      data: { buybackBudget: { decrement: amount }, roundRemainingLamports: { decrement: amount } },
    });
    if (!debit.count) return null;
    return tx.buyback.create({
      data: {
        coinMint: c.mint,
        round: c.buybackRound,
        chunk,
        idempotencyKey: `${c.mint}:${c.buybackRound}:${chunk}`,
        status: "PENDING",
        venue: plan.venue,
        solSpent: amount,
        quotedTokens: expected,
        minTokensOut: minOut,
        windowStart: c.lastDistributionAt ?? c.createdAt,
        windowEnd: now,
        attempts: 1,
      },
    });
  });
  if (!row) return "waiting";

  let prepared;
  try {
    prepared = await ctx.chain.prepareBuyback(refOf(c), amount, minOut);
  } catch (e) {
    await failAndRefund(ctx, row, (e as Error).message);
    return "failed";
  }
  await ctx.db.buyback.update({ where: { id: row.id }, data: { status: "SENT", signature: prepared.signature, lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight), sentAt: ctx.now(), ...(prepared.venue ? { venue: prepared.venue } : {}) } });
  try {
    await ctx.chain.broadcast(prepared);
  } catch (e) {
    ctx.log.warn({ err: e, id: row.id }, "broadcast error; will check the signature");
  }
  const status = await ctx.chain.wait(prepared.signature, prepared.lastValidBlockHeight);
  await settle(ctx, row.id, status);
  return status === "confirmed" ? "bought" : status === "pending" ? "waiting" : "failed";
}

/**
 * Refund a buyback that never spent its SOL. `fee` is the network fee of a transaction that landed
 * but failed: it was really paid by the buyback wallet, so it is charged to the coin's budget.
 */
async function failAndRefund(ctx: Ctx, row: Buyback, error: string, fee = 0n) {
  const charged = fee < row.solSpent ? fee : row.solSpent;
  const back = row.solSpent - charged;
  await ctx.db.$transaction(async (tx) => {
    const r = await tx.buyback.updateMany({ where: { id: row.id, status: { in: ["PENDING", "SENT"] } }, data: { status: "FAILED", error: error.slice(0, 1000), feeLamports: charged } });
    if (!r.count) return;
    await tx.coin.update({ where: { mint: row.coinMint }, data: { buybackBudget: { increment: back }, roundRemainingLamports: { increment: back }, lastBuybackAttemptAt: ctx.now() } });
  });
  await jobLog(ctx.db, "buyback", "warn", `buyback failed and was refunded: ${error.slice(0, 200)}`, row.idempotencyKey);
  const recent = await ctx.db.buyback.count({ where: { coinMint: row.coinMint, status: "FAILED", createdAt: { gte: new Date(ctx.now().getTime() - 3_600_000) } } });
  if (recent >= 3) await ctx.alerts.alert("buyback_failing", `${recent} failed buybacks in the last hour for ${row.coinMint}`, { mint: row.coinMint, error });
}

/** Resolve a sent buyback from its landed status. */
export async function settle(ctx: Ctx, id: string, status: "confirmed" | "failed" | "dropped" | "pending"): Promise<void> {
  const row = await ctx.db.buyback.findUniqueOrThrow({ where: { id } });
  if (status === "pending") return;
  if (status === "dropped") {
    await failAndRefund(ctx, row, "transaction expired without landing");
    return;
  }
  // Landed (confirmed or failed): only settle once the effects can be read. Never settle as zero.
  const fx = await ctx.chain.txEffects(row.signature!);
  if (!fx) {
    if (row.sentAt && ctx.now().getTime() - row.sentAt.getTime() > UNREADABLE_ALERT_MS) {
      await ctx.alerts.alert("buyback_unreadable", `buyback ${row.signature} landed but its effects can't be read yet; it stays open`, { id: row.id });
    }
    return;
  }
  if (status === "failed" || fx.failed) {
    await failAndRefund(ctx, row, "transaction failed on chain", fx.fee);
    return;
  }
  const received = fx.tokenDeltas.find((d) => d.mint === row.coinMint && d.owner === ctx.chain.wallets.distributor)?.delta ?? 0n;
  const at = fx.blockTime ? new Date(fx.blockTime * 1000) : ctx.now();
  // What the buyback wallet really paid beyond the swap amount (fee, a new distributor token account),
  // or, if negative, SOL the program didn't take (curve completion): settled against the coin's budget.
  const payerDelta = fx.lamportDeltas[ctx.chain.wallets.buyback];
  const overhead = payerDelta == null ? fx.fee : -payerDelta - row.solSpent;
  // A real refund (curve completion) can't exceed what was sent; anything more came from elsewhere
  // (e.g. wSOL already in the wallet) and must not be booked to this coin (audit).
  const refunded = overhead < 0n ? (-overhead < row.solSpent ? -overhead : row.solSpent) : 0n;
  const charged = overhead > 0n ? overhead : 0n;
  if (overhead < 0n && -overhead > row.solSpent + REFUND_TOLERANCE) {
    await ctx.alerts.alert("buyback_inflow", `buyback ${row.signature}: the wallet gained ${-overhead - row.solSpent} lamports more than the buy could refund; not booked`, { id: row.id });
  }
  if (received < row.minTokensOut) await ctx.alerts.alert("buyback_short", `buyback ${row.signature} delivered ${received} tokens, below the ${row.minTokensOut} minimum`, { id: row.id });
  await ctx.db.$transaction(async (tx) => {
    const r = await tx.buyback.updateMany({
      where: { id, status: "SENT" },
      data: { status: "CONFIRMED", tokensBought: received > 0n ? received : 0n, confirmedAt: at, windowEnd: at, slot: BigInt(fx.slot), feeLamports: charged, refundedLamports: refunded },
    });
    if (!r.count) return;
    await tx.coin.update({ where: { mint: row.coinMint }, data: { paidToHoldersLamports: { increment: row.solSpent - refunded }, buybackCount: { increment: 1 }, lastBuybackAt: at, buybackBudget: { increment: refunded } } });
    if (charged > 0n) await tx.coin.update({ where: { mint: row.coinMint }, data: { buybackBudget: { decrement: charged } } }); // may go below 0 (D-049)
  });
}

/** PENDING rows without a signature never left this process: fail and refund. SENT rows: ask the chain. */
export async function recoverInflight(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.buyback.findMany({ where: { status: { in: ["PENDING", "SENT"] } } });
  for (const r of rows) {
    if (r.status === "PENDING" || !r.signature) {
      await failAndRefund(ctx, r, "interrupted before sending");
      continue;
    }
    const st = await ctx.chain.check(r.signature, r.lastValidBlockHeight != null ? Number(r.lastValidBlockHeight) : null);
    await settle(ctx, r.id, st);
  }
}

/* -------------------------------- crediting -------------------------------- */

/**
 * Credit confirmed buybacks once (1) the indexer has seen every balance change up to them and
 * (2) holder balances were resynced from chain after the window closed (the mint stream can't see
 * every transfer; see syncHolders). The sync is requested here and done by the indexer.
 */
export async function creditConfirmed(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.buyback.findMany({ where: { status: "CONFIRMED", credited: false }, orderBy: { confirmedAt: "asc" } });
  for (const r of rows) {
    // tokens bought but not credited for long means holders are waiting on a stuck sync or indexer (audit)
    if (r.confirmedAt && ctx.now().getTime() - r.confirmedAt.getTime() > UNCREDITED_ALERT_MS) {
      await ctx.alerts.alert("buyback_uncredited", `buyback ${r.signature} confirmed more than 10 minutes ago and is not credited to holders yet`, { id: r.id, mint: r.coinMint });
    }
    const cur = await ctx.db.streamCursor.findUnique({ where: { stream: "mint:" + r.coinMint } });
    if (!cur || (r.slot != null && cur.slot < r.slot)) continue; // wait for the indexer
    const coin = await ctx.db.coin.findUnique({ where: { mint: r.coinMint }, select: { holderSyncedAt: true, needsHolderSync: true } });
    if (!coin?.holderSyncedAt || coin.holderSyncedAt < r.windowEnd) {
      if (!coin?.needsHolderSync) await ctx.db.coin.update({ where: { mint: r.coinMint }, data: { needsHolderSync: true } });
      continue;
    }
    await creditBuyback(ctx, r.id);
  }
}

/** Balance history of every wallet for [start, end), from BalanceEvent rows. */
export async function holderHistories(ctx: Pick<Ctx, "db">, mint: string, start: Date, end: Date): Promise<Map<string, HolderHistory>> {
  const before = await ctx.db.$queryRaw<{ wallet: string; balance: bigint }[]>(Prisma.sql`
    SELECT DISTINCT ON (wallet) wallet, balance FROM "BalanceEvent"
    WHERE "coinMint" = ${mint} AND "blockTime" < ${start}
    ORDER BY wallet, "blockTime" DESC, id DESC`);
  const inWindow = await ctx.db.balanceEvent.findMany({ where: { coinMint: mint, blockTime: { gte: start, lt: end } }, orderBy: [{ blockTime: "asc" }, { id: "asc" }] });
  const m = new Map<string, HolderHistory>();
  for (const b of before) m.set(b.wallet, { startBalance: BigInt(b.balance), points: [] });
  for (const e of inWindow) {
    const h = m.get(e.wallet) ?? { startBalance: 0n, points: [] };
    h.points.push({ t: sec(e.blockTime), balance: e.balance });
    m.set(e.wallet, h);
  }
  return m;
}

/**
 * Distribute a confirmed buyback (plus carried dust, forfeitures and harvested
 * tokens) pro rata by TWAB over the round's window. Idempotent.
 */
export async function creditBuyback(ctx: Ctx, buybackId: string): Promise<boolean> {
  const b = await ctx.db.buyback.findUniqueOrThrow({ where: { id: buybackId } });
  if (b.status !== "CONFIRMED" || b.credited) return false;
  const coin = await ctx.db.coin.findUniqueOrThrow({ where: { mint: b.coinMint } });
  const excluded = new Set(await excludedFor(ctx, coin.mint));
  // Wallets a chain sync caught holding less than recorded since this window began earn nothing from it
  // (their recorded balance was inflated by transfers the mint stream couldn't see).
  const caught = await ctx.db.holderState.findMany({ where: { coinMint: coin.mint, mismatchAt: { gte: b.windowStart } }, select: { wallet: true } });
  for (const h of caught) excluded.add(h.wallet);
  const histories = await holderHistories(ctx, coin.mint, b.windowStart, b.windowEnd);
  const weights = twabWeights(histories, sec(b.windowStart), sec(b.windowEnd), excluded);
  const total = b.tokensBought + coin.rewardDust + coin.forfeitPool + coin.extraRewardTokens;
  const dist = distribute(total, weights);

  const done = await ctx.db.$transaction(
    async (tx) => {
      const lock = await tx.buyback.updateMany({ where: { id: b.id, credited: false }, data: { credited: true, holderCount: dist.credits.size, dustCarried: dist.dust, carriedIn: total - b.tokensBought } });
      if (!lock.count) return false;
      if (dist.credits.size) {
        await tx.rewardCredit.createMany({
          data: [...dist.credits].map(([wallet, amount]) => ({ buybackId: b.id, coinMint: coin.mint, wallet, amount, weight: new Prisma.Decimal(weights.get(wallet)!.toString()) })),
        });
        for (const [wallet, amount] of dist.credits) {
          await tx.pending.upsert({ where: { coinMint_wallet: { coinMint: coin.mint, wallet } }, create: { coinMint: coin.mint, wallet, amount }, update: { amount: { increment: amount } } });
        }
      }
      // A round's chunks share one TWAB window; it moves forward only when the round is finished.
      const fresh = await tx.coin.findUniqueOrThrow({ where: { mint: coin.mint } });
      await tx.coin.update({
        where: { mint: coin.mint },
        // decrement (not reset) the pools by what this distribution used, so forfeits or harvests added meanwhile are kept
        data: {
          rewardDust: dist.dust,
          forfeitPool: { decrement: coin.forfeitPool },
          extraRewardTokens: { decrement: coin.extraRewardTokens },
          ...(fresh.roundRemainingLamports === 0n ? { lastDistributionAt: b.windowEnd } : {}),
        },
      });
      return true;
    },
    { timeout: 30_000 },
  );
  if (!done) return false;
  const updated = await ctx.db.buyback.findUniqueOrThrow({ where: { id: b.id } });
  const c2 = await ctx.db.coin.findUniqueOrThrow({ where: { mint: coin.mint } });
  await ctx.live.publish({ type: "buyback", buyback: buybackDto(updated, coin), paidToHoldersLamports: c2.paidToHoldersLamports.toString(), buybackCount: c2.buybackCount });
  await ctx.live.publish({ type: "vault", mint: coin.mint, buybackBudgetLamports: atLeastZero(c2.buybackBudget).toString() });
  return true;
}
