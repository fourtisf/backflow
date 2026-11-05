/**
 * Harvest worker (SPEC §3.4, §2.2). For each graduated coin, collect the LP
 * fees of the platform's locked position (Fee Key NFT), then settle:
 * SOL → 2/3 to the coin's buyback budget (sent to the buyback wallet), 1/3 to
 * the platform; coin tokens → 100% to holders (sent to the distributor and
 * added to the next distribution, never sold).
 *
 * Two transactions, each recorded before it is sent: the harvest, then the
 * settlement (amounts are only known after the harvest lands).
 */
import { atLeastZero, splitHarvest } from "@backflow/core";
import type { Coin, Harvest } from "@backflow/db";
import { jobLog, type Ctx } from "../ctx";

const WSOL = "So11111111111111111111111111111111111111112";
export const HARVEST_INTERVAL_MS = Number(process.env.HARVEST_INTERVAL_SEC ?? 3600) * 1000;
/** A harvest that collected less than this (and no coin tokens) backs the coin off to every HARVEST_IDLE_MS. */
export const HARVEST_DUST_LAMPORTS = 2_000_000n;
export const HARVEST_IDLE_MS = 6 * 3600_000;

export async function harvestTick(ctx: Ctx): Promise<void> {
  await recoverHarvests(ctx);
  const coins = await ctx.db.coin.findMany({ where: { status: "GRADUATED", cpmmPoolId: { not: null } } });
  for (const c of coins) {
    try {
      await harvestCoin(ctx, c);
    } catch (e) {
      ctx.log.error({ err: e, mint: c.mint }, "harvest failed");
      await jobLog(ctx.db, "harvest", "error", (e as Error).message, c.mint);
    }
  }
}

export async function harvestCoin(ctx: Ctx, c: Coin): Promise<"harvested" | "skipped"> {
  const last = await ctx.db.harvest.findFirst({ where: { coinMint: c.mint }, orderBy: { createdAt: "desc" } });
  if (last && (["PENDING", "SENT"].includes(last.status) || (last.status === "CONFIRMED" && !last.settled))) return "skipped";
  if (last && ctx.now().getTime() - last.createdAt.getTime() < HARVEST_INTERVAL_MS) return "skipped";
  if (c.nextHarvestAt && c.nextHarvestAt > ctx.now()) return "skipped"; // backed off after dust harvests
  let feeKey = c.feeKeyNftMint;
  if (!feeKey) {
    feeKey = await ctx.chain.findFeeKey(c.cpmmPoolId!);
    if (!feeKey) {
      await ctx.alerts.alert("fee_key_missing", `no Fee Key NFT found for graduated ${c.ticker}`, { mint: c.mint, pool: c.cpmmPoolId });
      return "skipped";
    }
    await ctx.db.coin.update({ where: { mint: c.mint }, data: { feeKeyNftMint: feeKey } });
  }
  if ((await ctx.chain.harvestableLp(feeKey)) <= 0n) return "skipped";
  const row = await ctx.db.harvest.create({ data: { coinMint: c.mint, status: "PENDING", feeKeyNftMint: feeKey } });
  let prepared;
  try {
    prepared = await ctx.chain.prepareHarvest({ mint: c.mint, poolId: c.poolId, cpmmPoolId: c.cpmmPoolId, graduated: true }, feeKey);
  } catch (e) {
    await ctx.db.harvest.update({ where: { id: row.id }, data: { status: "FAILED", error: (e as Error).message.slice(0, 1000) } });
    return "skipped";
  }
  await ctx.db.harvest.update({ where: { id: row.id }, data: { status: "SENT", signature: prepared.signature, lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight) } });
  try {
    await ctx.chain.broadcast(prepared);
  } catch (e) {
    ctx.log.warn({ err: e }, "harvest broadcast error; will check the signature");
  }
  await afterHarvest(ctx, row.id, await ctx.chain.wait(prepared.signature, prepared.lastValidBlockHeight));
  return "harvested";
}

async function afterHarvest(ctx: Ctx, id: string, st: "confirmed" | "failed" | "dropped" | "pending") {
  if (st === "pending") return;
  if (st !== "confirmed") {
    await ctx.db.harvest.update({ where: { id }, data: { status: "FAILED", error: st } });
    return;
  }
  const h = await ctx.db.harvest.findUniqueOrThrow({ where: { id } });
  const fx = await ctx.chain.txEffects(h.signature!);
  if (!fx) return; // landed but not readable yet: stays SENT and is retried, never recorded as zero
  if (fx.failed) {
    await ctx.db.harvest.update({ where: { id }, data: { status: "FAILED", error: "transaction failed on chain" } });
    return;
  }
  const owner = ctx.chain.wallets.lockNft;
  const sol = fx.tokenDeltas.find((d) => d.mint === WSOL && d.owner === owner)?.delta ?? 0n;
  const tokens = fx.tokenDeltas.find((d) => d.mint === h.coinMint && d.owner === owner)?.delta ?? 0n;
  const split = splitHarvest(sol > 0n ? sol : 0n, tokens > 0n ? tokens : 0n);
  await ctx.db.harvest.update({
    where: { id },
    data: { status: "CONFIRMED", confirmedAt: ctx.now(), solAmount: sol, tokenAmount: tokens, solToBuyback: split.solToBuyback, solToPlatform: split.solToPlatform, tokensToHolders: split.tokensToHolders },
  });
  const dust = sol < HARVEST_DUST_LAMPORTS && tokens <= 0n;
  await ctx.db.coin.update({ where: { mint: h.coinMint }, data: { nextHarvestAt: new Date(ctx.now().getTime() + (dust ? HARVEST_IDLE_MS : HARVEST_INTERVAL_MS)) } });
  await settleHarvest(ctx, id);
}

/** Second transaction: unwrap, pay the buyback wallet and the distributor; then credit the DB. */
export async function settleHarvest(ctx: Ctx, id: string): Promise<void> {
  const h = await ctx.db.harvest.findUniqueOrThrow({ where: { id } });
  if (h.settled || h.status !== "CONFIRMED") return;
  if (h.solToBuyback === 0n && h.tokensToHolders === 0n && h.solToPlatform === 0n) {
    await ctx.db.harvest.update({ where: { id }, data: { settled: true } });
    return;
  }
  if (h.settleSignature) {
    const st = await ctx.chain.check(h.settleSignature, h.settleLastValidBlockHeight != null ? Number(h.settleLastValidBlockHeight) : null);
    if (st === "pending") return;
    if (st === "confirmed") return creditHarvest(ctx, h);
    // failed or dropped: build a new settlement below
  }
  // the platform's third also leaves the hot claim wallet, to the treasury (CLAUDE.md rule 6)
  const prepared = await ctx.chain.prepareHarvestSettle(h.coinMint, h.solToBuyback, h.tokensToHolders, h.solToPlatform);
  await ctx.db.harvest.update({ where: { id }, data: { settleSignature: prepared.signature, settleLastValidBlockHeight: BigInt(prepared.lastValidBlockHeight) } });
  try {
    await ctx.chain.broadcast(prepared);
  } catch (e) {
    ctx.log.warn({ err: e }, "settle broadcast error; will check the signature");
  }
  const st = await ctx.chain.wait(prepared.signature, prepared.lastValidBlockHeight);
  if (st === "confirmed") await creditHarvest(ctx, await ctx.db.harvest.findUniqueOrThrow({ where: { id } }));
}

async function creditHarvest(ctx: Ctx, h: Harvest) {
  await ctx.db.$transaction(async (tx) => {
    const r = await tx.harvest.updateMany({ where: { id: h.id, settled: false }, data: { settled: true } });
    if (!r.count) return;
    await tx.coin.update({ where: { mint: h.coinMint }, data: { buybackBudget: { increment: h.solToBuyback }, extraRewardTokens: { increment: h.tokensToHolders } } });
  });
  const c = await ctx.db.coin.findUniqueOrThrow({ where: { mint: h.coinMint } });
  await ctx.live.publish({ type: "vault", mint: c.mint, buybackBudgetLamports: atLeastZero(c.buybackBudget).toString() });
}

export async function recoverHarvests(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.harvest.findMany({ where: { OR: [{ status: { in: ["PENDING", "SENT"] } }, { status: "CONFIRMED", settled: false }] } });
  for (const h of rows) {
    try {
      if (h.status === "PENDING" || (h.status === "SENT" && !h.signature)) {
        await ctx.db.harvest.update({ where: { id: h.id }, data: { status: "FAILED", error: "interrupted before sending" } });
      } else if (h.status === "SENT") {
        await afterHarvest(ctx, h.id, await ctx.chain.check(h.signature!, h.lastValidBlockHeight != null ? Number(h.lastValidBlockHeight) : null));
      } else await settleHarvest(ctx, h.id);
    } catch (e) {
      // one bad row must not stop the others (audit)
      ctx.log.error({ err: e, harvestId: h.id }, "harvest recovery failed");
      await jobLog(ctx.db, "harvest", "error", `harvest ${h.id}: ${(e as Error).message}`, h.id);
    }
  }
}
