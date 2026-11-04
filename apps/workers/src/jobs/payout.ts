/**
 * Payout worker (SPEC §3.3). Every PAYOUT_INTERVAL_SEC, for each coin:
 * forfeit pending of wallets whose balance decreased since the last payout,
 * roll over amounts below the minimum, and send the rest in batched SPL
 * transfers from the distributor. Idempotent per (coin, round, wallet):
 * Payout.idempotencyKey = "<mint>:<round>", PayoutItem key (payoutId, wallet).
 * Paid amounts are reserved (taken off Pending) before sending and restored if
 * a batch fails or expires.
 */
import { CURVE, FEES, batches, formatUnits, minPayoutTokens, planPayout } from "@backflow/core";
import { maxTransfersPerTx } from "@backflow/chain";
import type { Coin } from "@backflow/db";
import { SETTING, getSetting, jobLog, setSetting, type Ctx } from "../ctx";

const SETTING_LAST = "payout_last_at";

export async function payoutTick(ctx: Ctx, force = false): Promise<number | null> {
  await recoverPayouts(ctx);
  if (await getSetting(ctx.db, SETTING.payoutsPaused, false)) return null;
  const last = await getSetting<string | null>(ctx.db, SETTING_LAST, null);
  const now = ctx.now();
  if (!force && last && now.getTime() - Date.parse(last) < FEES.payout.intervalSec * 1000) return null;
  const round = (await getSetting<number>(ctx.db, SETTING.payoutRound, 0)) + 1;
  await setSetting(ctx.db, SETTING.payoutRound, round);
  await setSetting(ctx.db, SETTING_LAST, now.toISOString());

  const coins = await ctx.db.coin.findMany({ where: { payoutsPaused: false } });
  const paid = new Set<string>();
  for (const c of coins) {
    try {
      for (const w of await payCoin(ctx, c, round)) paid.add(w);
    } catch (e) {
      ctx.log.error({ err: e, mint: c.mint }, "payout failed");
      await jobLog(ctx.db, "payout", "error", (e as Error).message, `${c.mint}:${round}`);
    }
  }
  const next = new Date(now.getTime() + FEES.payout.intervalSec * 1000).toISOString();
  await ctx.live.publish({ type: "payout", round, nextPayoutAt: next, wallets: [...paid] });
  return round;
}

/** Price per whole token in USD, from the coin's market cap (display-grade; only used for the minimum). */
function priceUsd(c: Coin): number | null {
  const m = Number(c.mcapUsd);
  return m > 0 ? m / Number(CURVE.supplyTokens) : null;
}

export async function payCoin(ctx: Ctx, c: Coin, round: number): Promise<string[]> {
  const key = `${c.mint}:${round}`;
  if (await ctx.db.payout.findUnique({ where: { idempotencyKey: key } })) return [];
  const pendings = await ctx.db.pending.findMany({ where: { coinMint: c.mint, amount: { gt: 0n } } });
  const states = await ctx.db.holderState.findMany({ where: { coinMint: c.mint, wallet: { in: pendings.map((p) => p.wallet) } } });
  const decreased = new Set(states.filter((s) => s.decreasedSincePayout).map((s) => s.wallet));
  const minTokens = minPayoutTokens(priceUsd(c), c.decimals);
  const plan = planPayout(
    pendings.map((p) => ({ wallet: p.wallet, amount: p.amount, decreased: decreased.has(p.wallet) })),
    minTokens ?? BigInt(Number.MAX_SAFE_INTEGER) * 10n ** 18n, // unknown price: pay nothing, roll everything over
  );

  // Recipients must still have their token account (SPEC §3.3); otherwise roll over.
  const have = plan.pay.length ? await ctx.chain.existingTokenAccounts(c.mint, plan.pay.map((p) => p.wallet)) : new Set<string>();
  const pay = plan.pay.filter((p) => have.has(p.wallet));
  const total = pay.reduce((s, p) => s + p.amount, 0n);
  if (total > 0n) {
    const bal = await ctx.chain.tokenBalance(ctx.chain.wallets.distributor, c.mint);
    if (bal < total) {
      await ctx.alerts.alert("distributor_short", `distributor holds ${bal} ${c.ticker} but owes ${total}; payout skipped`, { mint: c.mint });
      return [];
    }
  }

  const perTx = maxTransfersPerTx();
  const groups = batches(pay, perTx);
  const payout = await ctx.db.$transaction(async (tx) => {
    const created = await tx.payout.create({
      data: { round, coinMint: c.mint, idempotencyKey: key, status: pay.length ? "PENDING" : "CONFIRMED", totalAmount: total, forfeitedAmount: plan.forfeited, rolledOverAmount: plan.rollover.reduce((s, r) => s + r.amount, 0n) + (plan.total - total), completedAt: pay.length ? null : ctx.now() },
    });
    if (pay.length) await tx.payoutItem.createMany({ data: groups.flatMap((g, i) => g.map((p) => ({ payoutId: created.id, wallet: p.wallet, amount: p.amount, batch: i }))) });
    for (const p of pay) await tx.pending.update({ where: { coinMint_wallet: { coinMint: c.mint, wallet: p.wallet } }, data: { amount: { decrement: p.amount } } });
    for (const f of plan.forfeits) {
      await tx.pending.update({ where: { coinMint_wallet: { coinMint: c.mint, wallet: f.wallet } }, data: { amount: { decrement: f.amount } } });
      await tx.forfeiture.create({ data: { payoutId: created.id, coinMint: c.mint, wallet: f.wallet, amount: f.amount } });
    }
    if (plan.forfeited > 0n) await tx.coin.update({ where: { mint: c.mint }, data: { forfeitPool: { increment: plan.forfeited } } });
    // The forfeiture window restarts at every payout of this coin.
    await tx.holderState.updateMany({ where: { coinMint: c.mint, decreasedSincePayout: true }, data: { decreasedSincePayout: false } });
    return created;
  });
  if (plan.forfeited > 0n) await jobLog(ctx.db, "payout", "info", `forfeited ${plan.forfeited} from ${plan.forfeitedWallets.length} wallets`, key);

  const paidWallets: string[] = [];
  for (let i = 0; i < groups.length; i++) paidWallets.push(...(await sendBatch(ctx, payout.id, c.mint, i)));
  await finishPayout(ctx, payout.id);
  return paidWallets;
}

async function sendBatch(ctx: Ctx, payoutId: string, mint: string, batch: number): Promise<string[]> {
  const items = await ctx.db.payoutItem.findMany({ where: { payoutId, batch, status: "PENDING" } });
  if (!items.length) return [];
  let prepared;
  try {
    prepared = await ctx.chain.prepareTransfers(mint, items.map((i) => ({ wallet: i.wallet, amount: i.amount })));
  } catch (e) {
    await failBatch(ctx, payoutId, mint, batch, (e as Error).message);
    return [];
  }
  await ctx.db.payoutItem.updateMany({ where: { payoutId, batch, status: "PENDING" }, data: { status: "SENT", signature: prepared.signature, lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight), attempts: { increment: 1 } } });
  try {
    await ctx.chain.broadcast(prepared);
  } catch (e) {
    ctx.log.warn({ err: e }, "payout broadcast error; will check the signature");
  }
  const st = await ctx.chain.wait(prepared.signature, prepared.lastValidBlockHeight);
  return settleBatch(ctx, payoutId, mint, batch, st);
}

async function settleBatch(ctx: Ctx, payoutId: string, mint: string, batch: number, st: "confirmed" | "failed" | "dropped" | "pending"): Promise<string[]> {
  if (st === "pending") return [];
  if (st !== "confirmed") {
    await failBatch(ctx, payoutId, mint, batch, st === "failed" ? "transfer failed on chain" : "transfer expired without landing");
    return [];
  }
  const items = await ctx.db.payoutItem.findMany({ where: { payoutId, batch, status: "SENT" } });
  await ctx.db.$transaction(async (tx) => {
    const r = await tx.payoutItem.updateMany({ where: { payoutId, batch, status: "SENT" }, data: { status: "CONFIRMED" } });
    if (!r.count) return;
    for (const i of items) {
      await tx.holderState.upsert({
        where: { coinMint_wallet: { coinMint: mint, wallet: i.wallet } },
        create: { coinMint: mint, wallet: i.wallet, receivedTotal: i.amount },
        update: { receivedTotal: { increment: i.amount } },
      });
    }
  });
  void notifyPayouts(ctx, mint, items).catch(() => {});
  return items.map((i) => i.wallet);
}

/** Best-effort Telegram message to holders who linked their wallet (no effect on funds). */
async function notifyPayouts(ctx: Ctx, mint: string, items: { wallet: string; amount: bigint }[]) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !items.length) return;
  const links = await ctx.db.telegramLink.findMany({ where: { wallet: { in: items.map((i) => i.wallet) } } });
  if (!links.length) return;
  const coin = await ctx.db.coin.findUnique({ where: { mint }, select: { ticker: true, decimals: true } });
  for (const l of links) {
    const it = items.find((i) => i.wallet === l.wallet)!;
    const text = `Payout landed: ${formatUnits(it.amount, coin?.decimals ?? 6)} $${coin?.ticker ?? "?"} sent to ${l.wallet.slice(0, 4)}…${l.wallet.slice(-4)}.`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: l.chatId, text }) }).catch(() => {});
  }
}

/** Restore reserved pending amounts for a batch that will never land. */
async function failBatch(ctx: Ctx, payoutId: string, mint: string, batch: number, error: string) {
  const items = await ctx.db.payoutItem.findMany({ where: { payoutId, batch, status: { in: ["PENDING", "SENT"] } } });
  await ctx.db.$transaction(async (tx) => {
    const r = await tx.payoutItem.updateMany({ where: { payoutId, batch, status: { in: ["PENDING", "SENT"] } }, data: { status: "FAILED", error: error.slice(0, 500) } });
    if (!r.count) return;
    for (const i of items) await tx.pending.update({ where: { coinMint_wallet: { coinMint: mint, wallet: i.wallet } }, data: { amount: { increment: i.amount } } });
  });
  await jobLog(ctx.db, "payout", "warn", `payout batch failed and was restored: ${error}`, `${payoutId}:${batch}`);
}

async function finishPayout(ctx: Ctx, payoutId: string) {
  const open = await ctx.db.payoutItem.count({ where: { payoutId, status: { in: ["PENDING", "SENT"] } } });
  if (open) return;
  const failed = await ctx.db.payoutItem.count({ where: { payoutId, status: "FAILED" } });
  await ctx.db.payout.update({ where: { id: payoutId }, data: { status: failed ? "FAILED" : "CONFIRMED", completedAt: ctx.now() } });
  if (failed >= 5) await ctx.alerts.alert("payout_failures", `${failed} payout transfers failed in payout ${payoutId}`);
}

/** Check every SENT batch against the chain; PENDING items of an interrupted payout are sent now. */
export async function recoverPayouts(ctx: Ctx): Promise<void> {
  const open = await ctx.db.payout.findMany({ where: { status: { in: ["PENDING", "SENT"] } } });
  for (const p of open) {
    const sent = await ctx.db.payoutItem.findMany({ where: { payoutId: p.id, status: "SENT" }, distinct: ["batch"] });
    for (const s of sent) {
      const st = await ctx.chain.check(s.signature!, s.lastValidBlockHeight != null ? Number(s.lastValidBlockHeight) : null);
      await settleBatch(ctx, p.id, p.coinMint, s.batch, st);
    }
    const pending = await ctx.db.payoutItem.findMany({ where: { payoutId: p.id, status: "PENDING" }, distinct: ["batch"] });
    for (const b of pending) await sendBatch(ctx, p.id, p.coinMint, b.batch);
    await finishPayout(ctx, p.id);
  }
}
