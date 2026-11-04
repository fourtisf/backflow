/**
 * Reconcile worker (SPEC §6.3, §10). Claims the shared platform fee vault,
 * checks the claimed lamports against Σ FeeAccrual.platformFee (0.5%
 * tolerance), then moves Σ holdersPart to the buyback wallet and the platform
 * share to the treasury. A mismatch pauses buybacks and alerts. Also watches
 * indexer lag, hot-wallet balances and failed payouts.
 */
import { FEES, reconcile } from "@backflow/core";
import type { VaultClaim } from "@backflow/db";
import { SETTING, getSetting, jobLog, setSetting, type Ctx } from "../ctx";

const WSOL = "So11111111111111111111111111111111111111112";
export const CLAIM_INTERVAL_MS = Number(process.env.CLAIM_INTERVAL_SEC ?? 3600) * 1000;
const MAX_LAG_SLOTS = 75; // ≈ 30 s
const LOW = { buyback: 50_000_000n, distributor: 20_000_000n, claim: 10_000_000n };

export async function reconcileTick(ctx: Ctx): Promise<void> {
  const lag = await indexerLag(ctx);
  await checkWallets(ctx);
  await checkFailures(ctx);
  await checkInvariants(ctx);
  await recoverClaims(ctx);
  if (lag == null || lag > MAX_LAG_SLOTS) return; // never claim while the indexer is behind
  await maybeClaim(ctx);
}

export async function indexerLag(ctx: Ctx): Promise<number | null> {
  const cur = await ctx.db.streamCursor.findUnique({ where: { stream: `platform:${ctx.chain.platformConfig}` } });
  if (!cur) return null;
  const slot = await ctx.chain.currentSlot();
  const lag = slot - Number(cur.slot);
  // a quiet platform has no new signatures; lag only matters when the vault grew past what we indexed
  if (lag > MAX_LAG_SLOTS) {
    const vault = await ctx.chain.platformVaultBalance();
    const unclaimed = await ctx.db.feeAccrual.aggregate({ where: { claimId: null }, _sum: { platformFee: true } });
    if (vault > (unclaimed._sum.platformFee ?? 0n) + 1_000_000n) {
      await ctx.alerts.alert("indexer_lag", `indexer is ${lag} slots behind and the fee vault holds more than indexed`, { lag });
      return lag;
    }
    return 0;
  }
  return lag;
}

async function checkWallets(ctx: Ctx) {
  const w = ctx.chain.wallets;
  for (const [name, addr] of [["buyback", w.buyback], ["distributor", w.distributor], ["claim", w.claim]] as const) {
    if (!addr) continue;
    const bal = await ctx.chain.solBalance(addr);
    if (bal < LOW[name]) await ctx.alerts.alert("low_balance", `${name} wallet is low: ${bal} lamports`, { wallet: addr });
  }
}

async function checkFailures(ctx: Ctx) {
  const hourAgo = new Date(ctx.now().getTime() - 3_600_000);
  const failed = await ctx.db.payoutItem.count({ where: { status: "FAILED", payout: { createdAt: { gte: hourAgo } } } });
  if (failed >= Number(process.env.ALERT_FAILED_PAYOUTS ?? 10)) await ctx.alerts.alert("payout_failures", `${failed} payout transfers failed in the last hour`);
}

/** Allowed shortfall before an invariant trips (rounding, rent, in-flight fees). */
const SOL_TOLERANCE = 20_000_000n;

export interface InvariantReport {
  tokenShortfalls: { mint: string; owed: bigint; held: bigint }[];
  solShortfall: { owed: bigint; held: bigint } | null;
}

/**
 * Money invariants (SECURITY.md):
 *  1. per coin, the distributor holds at least what is owed to holders: Σ pending + forfeit pool +
 *     carried dust + harvested tokens + payout items not yet sent. A shortfall pauses that coin's payouts.
 *  2. the buyback wallet holds at least the budgets that have already been funded (Σ budgets minus
 *     holders' parts still in the fee vault or in transit). A shortfall pauses all buybacks.
 * Reads run in one REPEATABLE READ transaction so a concurrent payout can't be counted twice.
 */
export async function checkInvariants(ctx: Ctx): Promise<InvariantReport> {
  const report: InvariantReport = { tokenShortfalls: [], solShortfall: null };
  const snapshot = await ctx.db.$transaction(
    async (tx) => {
      const coins = await tx.coin.findMany({ select: { mint: true, ticker: true, forfeitPool: true, rewardDust: true, extraRewardTokens: true, buybackBudget: true, payoutsPaused: true } });
      const pending = await tx.pending.groupBy({ by: ["coinMint"], _sum: { amount: true } });
      const unsent = await tx.payoutItem.findMany({ where: { status: "PENDING" }, select: { amount: true, payout: { select: { coinMint: true } } } });
      const notTransferred = await tx.feeAccrual.aggregate({ where: { OR: [{ claimId: null }, { claim: { stage: { not: "done" } } }] }, _sum: { holdersPart: true } });
      return { coins, pending, unsent, notTransferred: notTransferred._sum.holdersPart ?? 0n };
    },
    { isolationLevel: "RepeatableRead" },
  );
  const distributor = ctx.chain.wallets.distributor;
  for (const c of snapshot.coins) {
    const pend = snapshot.pending.find((p) => p.coinMint === c.mint)?._sum.amount ?? 0n;
    const inFlight = snapshot.unsent.filter((u) => u.payout.coinMint === c.mint).reduce((s, u) => s + u.amount, 0n);
    const owed = pend + c.forfeitPool + c.rewardDust + c.extraRewardTokens + inFlight;
    if (owed === 0n || !distributor) continue;
    const held = await ctx.chain.tokenBalance(distributor, c.mint);
    if (held < owed) {
      report.tokenShortfalls.push({ mint: c.mint, owed, held });
      if (!c.payoutsPaused) await ctx.db.coin.update({ where: { mint: c.mint }, data: { payoutsPaused: true } });
      await ctx.alerts.alert("invariant_tokens", `distributor holds ${held} ${c.ticker} but owes ${owed}; payouts for ${c.ticker} paused`, { mint: c.mint });
    }
  }
  const budgets = snapshot.coins.reduce((s, c) => s + c.buybackBudget, 0n);
  const funded = budgets - snapshot.notTransferred;
  if (funded > 0n && ctx.chain.wallets.buyback) {
    const held = await ctx.chain.solBalance(ctx.chain.wallets.buyback);
    if (held + SOL_TOLERANCE < funded) {
      report.solShortfall = { owed: funded, held };
      await setSetting(ctx.db, SETTING.buybacksPaused, true, "invariant");
      await ctx.alerts.alert("invariant_sol", `buyback wallet holds ${held} lamports but funded budgets total ${funded}; buybacks paused`);
    }
  }
  return report;
}

async function maybeClaim(ctx: Ctx): Promise<void> {
  const open = await ctx.db.vaultClaim.findFirst({ where: { stage: { not: "done" }, status: { not: "FAILED" } } });
  if (open) return;
  const cur = await ctx.db.streamCursor.findUnique({ where: { stream: `platform:${ctx.chain.platformConfig}` } });
  if (!cur) return;
  const unclaimedHolders = await ctx.db.feeAccrual.aggregate({ where: { claimId: null }, _sum: { holdersPart: true } });
  const last = await ctx.db.vaultClaim.findFirst({ where: { status: "CONFIRMED" }, orderBy: { createdAt: "desc" } });
  const due = (unclaimedHolders._sum.holdersPart ?? 0n) >= FEES.buyback.thresholdLamports || !last || ctx.now().getTime() - last.createdAt.getTime() > CLAIM_INTERVAL_MS;
  if (!due) return;
  const vault = await ctx.chain.platformVaultBalance();
  if (vault === 0n) return;

  const claim = await ctx.db.$transaction(async (tx) => {
    const rows = await tx.feeAccrual.findMany({ where: { claimId: null, trade: { slot: { lte: cur.slot } } }, select: { tradeSignature: true, tradeEventIndex: true, platformFee: true } });
    if (!rows.length) return null;
    const expected = rows.reduce((s, r) => s + r.platformFee, 0n);
    const c = await tx.vaultClaim.create({ data: { status: "PENDING", expectedLamports: expected, stage: "claim" } });
    await tx.feeAccrual.updateMany({ where: { claimId: null, trade: { slot: { lte: cur.slot } } }, data: { claimId: c.id } });
    return c;
  });
  if (!claim) return;
  let prepared;
  try {
    prepared = await ctx.chain.prepareVaultClaim();
  } catch (e) {
    await releaseClaim(ctx, claim, (e as Error).message);
    return;
  }
  await ctx.db.vaultClaim.update({ where: { id: claim.id }, data: { status: "SENT", signature: prepared.signature, lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight) } });
  try {
    await ctx.chain.broadcast(prepared);
  } catch (e) {
    ctx.log.warn({ err: e }, "claim broadcast error; will check the signature");
  }
  await afterClaim(ctx, claim.id, await ctx.chain.wait(prepared.signature, prepared.lastValidBlockHeight));
}

async function releaseClaim(ctx: Ctx, c: VaultClaim, error: string) {
  await ctx.db.$transaction([
    ctx.db.feeAccrual.updateMany({ where: { claimId: c.id }, data: { claimId: null } }),
    ctx.db.vaultClaim.update({ where: { id: c.id }, data: { status: "FAILED", error: error.slice(0, 1000) } }),
  ]);
}

async function afterClaim(ctx: Ctx, id: string, st: "confirmed" | "failed" | "dropped" | "pending") {
  const c = await ctx.db.vaultClaim.findUniqueOrThrow({ where: { id } });
  if (st === "pending") return;
  if (st !== "confirmed") return releaseClaim(ctx, c, st);
  const fx = await ctx.chain.txEffects(c.signature!);
  // claimed = what left the vault (a program-owned wSOL account)
  const vaultDelta = fx?.tokenDeltas.find((d) => d.mint === WSOL && d.programOwned && d.delta < 0n)?.delta ?? 0n;
  const claimed = -vaultDelta;
  const r = reconcile(claimed, c.expectedLamports);
  await ctx.db.vaultClaim.update({ where: { id }, data: { status: "CONFIRMED", claimedLamports: claimed, mismatchPpm: Number(r.mismatchPpm), confirmedAt: ctx.now(), stage: r.ok ? "transfer" : "held" } });
  if (!r.ok) {
    await setSetting(ctx.db, SETTING.buybacksPaused, true, "reconcile");
    await ctx.alerts.alert("reconcile_mismatch", `claimed ${claimed} lamports but accrued ${c.expectedLamports} (${Number(r.mismatchPpm) / 10_000}%). Buybacks paused.`, { claimId: id });
    return;
  }
  await transferClaim(ctx, id);
}

/** Send Σ holdersPart to the buyback wallet and the rest to the treasury. */
export async function transferClaim(ctx: Ctx, id: string): Promise<void> {
  const c = await ctx.db.vaultClaim.findUniqueOrThrow({ where: { id } });
  if (c.stage !== "transfer") return;
  if (c.buybackTransferSig) {
    const st = await ctx.chain.check(c.buybackTransferSig, c.transferLastValidBlockHeight != null ? Number(c.transferLastValidBlockHeight) : null);
    if (st === "pending") return;
    if (st === "confirmed") {
      await ctx.db.vaultClaim.update({ where: { id }, data: { stage: "done" } });
      return;
    }
  }
  const sums = await ctx.db.feeAccrual.aggregate({ where: { claimId: id }, _sum: { holdersPart: true } });
  const toBuyback = sums._sum.holdersPart ?? 0n;
  const toTreasury = c.claimedLamports - toBuyback; // platform share plus rounding within tolerance
  const outs = [
    { to: ctx.chain.wallets.buyback, lamports: toBuyback },
    { to: ctx.chain.wallets.treasury, lamports: toTreasury > 0n ? toTreasury : 0n },
  ];
  const prepared = await ctx.chain.prepareClaimTransfers(outs);
  await ctx.db.vaultClaim.update({ where: { id }, data: { buybackTransferSig: prepared.signature, treasuryTransferSig: prepared.signature, transferLastValidBlockHeight: BigInt(prepared.lastValidBlockHeight), toBuybackLamports: toBuyback, toTreasuryLamports: outs[1]!.lamports } });
  try {
    await ctx.chain.broadcast(prepared);
  } catch (e) {
    ctx.log.warn({ err: e }, "claim transfer broadcast error; will check the signature");
  }
  const st = await ctx.chain.wait(prepared.signature, prepared.lastValidBlockHeight);
  if (st === "confirmed") await ctx.db.vaultClaim.update({ where: { id }, data: { stage: "done" } });
  else if (st !== "pending") await jobLog(ctx.db, "reconcile", "warn", `claim transfer ${st}; will retry`, id);
}

export async function recoverClaims(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.vaultClaim.findMany({ where: { OR: [{ status: { in: ["PENDING", "SENT"] } }, { stage: "transfer" }] } });
  for (const c of rows) {
    if (c.status === "PENDING" || (c.status === "SENT" && !c.signature)) await releaseClaim(ctx, c, "interrupted before sending");
    else if (c.status === "SENT") await afterClaim(ctx, c.id, await ctx.chain.check(c.signature!, c.lastValidBlockHeight != null ? Number(c.lastValidBlockHeight) : null));
    else if (c.stage === "transfer") await transferClaim(ctx, c.id);
  }
}

export async function buybacksPaused(ctx: Ctx) {
  return getSetting(ctx.db, SETTING.buybacksPaused, false);
}
