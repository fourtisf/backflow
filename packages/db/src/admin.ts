/**
 * Admin actions (SPEC §5.6, §10). There is no admin page or admin API on the
 * web: these run only from the server shell (`pnpm admin <command>`, see
 * scripts/src/admin.ts), so there is no admin door on the internet.
 *
 * Every write is recorded in JobLog (job "admin", key = who ran it) in the same
 * database transaction as the change.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

/** Who ran the command, e.g. "cli:ops@backflow-vps". Written to the audit log. */
export type Actor = string;

export class AdminError extends Error {
  constructor(
    readonly code: "not_found" | "ticker_taken" | "conflict" | "bad_request",
    message: string,
  ) {
    super(message);
  }
}

const SETTINGS = { buybacks: "buybacks_paused", payouts: "payouts_paused" } as const;
export type PauseKind = keyof typeof SETTINGS;

const audit = (db: PrismaClient | Prisma.TransactionClient, actor: Actor, message: string, data?: Record<string, unknown>) =>
  db.jobLog.create({ data: { job: "admin", key: actor, level: "info", message, data: data as never } });

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Settings, budgets, unclaimed fees, failures of the last 24 h, held claims, indexer cursor, dead letters. */
export async function adminOverview(db: PrismaClient, platformConfig: string | null) {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const [settings, budgets, unclaimed, cursor, held, deadLetters] = await Promise.all([
    db.setting.findMany(),
    db.coin.aggregate({ _sum: { buybackBudget: true } }),
    db.feeAccrual.aggregate({ where: { claimId: null }, _sum: { platformFee: true, holdersPart: true } }),
    platformConfig ? db.streamCursor.findUnique({ where: { stream: `platform:${platformConfig}` } }) : null,
    db.vaultClaim.count({ where: { stage: "held" } }),
    db.indexerDeadLetter.count({ where: { resolvedAt: null } }),
  ]);
  return {
    settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
    buybackBudgets: budgets._sum.buybackBudget ?? 0n,
    unclaimedPlatformFees: unclaimed._sum.platformFee ?? 0n,
    unclaimedHoldersPart: unclaimed._sum.holdersPart ?? 0n,
    indexerSlot: cursor?.slot ?? null,
    indexerStuckOn: cursor?.stuckSignature ?? null,
    heldClaims: held,
    deadLetters,
    failed24h: {
      buybacks: await db.buyback.count({ where: { status: "FAILED", createdAt: { gte: dayAgo } } }),
      payoutItems: await db.payoutItem.count({ where: { status: "FAILED", payout: { createdAt: { gte: dayAgo } } } }),
      claims: await db.vaultClaim.count({ where: { status: "FAILED", createdAt: { gte: dayAgo } } }),
      harvests: await db.harvest.count({ where: { status: "FAILED", createdAt: { gte: dayAgo } } }),
    },
  };
}

/** Newest coins with distinct reporters per coin (one reporter can't bury real reports by repeating). */
export async function listCoins(db: PrismaClient, opts: { reportedOnly?: boolean; hiddenOnly?: boolean; limit?: number } = {}) {
  const coins = await db.coin.findMany({
    where: opts.hiddenOnly ? { hidden: true } : undefined,
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 200, 1000),
    select: { mint: true, name: true, ticker: true, hidden: true, hiddenReason: true, launchedViaUs: true, status: true, buybacksPaused: true, payoutsPaused: true, buybackBudget: true, createdAt: true },
  });
  const reports = await db.$queryRaw<{ coinMint: string; n: number }[]>(Prisma.sql`
    SELECT "coinMint", COUNT(DISTINCT "by")::int AS n FROM "ModerationFlag" WHERE action = 'report' GROUP BY "coinMint"`);
  const n = new Map(reports.map((x) => [x.coinMint, Number(x.n)]));
  return coins
    .map((c) => ({ ...c, reports: n.get(c.mint) ?? 0 }))
    .filter((c) => !opts.reportedOnly || c.reports > 0)
    .sort((a, b) => b.reports - a.reports);
}

export const coinReports = (db: PrismaClient, mint: string) => db.moderationFlag.findMany({ where: { coinMint: mint, action: "report" }, orderBy: { createdAt: "desc" }, take: 100 });

/** Hide or unhide a coin. Unhiding a duplicate-ticker coin is refused while another coin owns the ticker. */
/**
 * Re-reads a coin from chain on the indexer's next pass: holders (from all token accounts of the mint) and,
 * if its logo/links never loaded, its metadata (D-055). Changes no money state.
 */
export async function refreshCoin(db: PrismaClient, mint: string, actor: Actor): Promise<{ metadata: boolean }> {
  const c = await db.coin.findUnique({ where: { mint } });
  if (!c) throw new AdminError("not_found", "No such coin.");
  const metadata = c.metadataStatus !== "ok" && !!c.metadataUri;
  await db.$transaction([
    db.coin.update({ where: { mint }, data: { needsHolderSync: true, ...(metadata ? { metadataStatus: "pending", metadataAttempts: 0 } : {}) } }),
    audit(db, actor, "refreshed coin", { mint, metadata }),
  ]);
  return { metadata };
}

export async function setHidden(db: PrismaClient, mint: string, hidden: boolean, reason: string | null, actor: Actor): Promise<void> {
  const c = await db.coin.findUnique({ where: { mint } });
  if (!c) throw new AdminError("not_found", "No such coin.");
  if (!hidden && !c.tickerSlot) {
    const owner = await db.coin.findUnique({ where: { tickerSlot: c.tickerKey } });
    if (owner && owner.mint !== c.mint) throw new AdminError("ticker_taken", `$${c.ticker} is already used by another coin.`);
  }
  const why = reason?.slice(0, 200) || null;
  await db.$transaction([
    db.coin.update({ where: { mint }, data: { hidden, hiddenReason: hidden ? why : null, ...(!hidden && !c.tickerSlot ? { tickerSlot: c.tickerKey } : {}) } }),
    db.moderationFlag.create({ data: { coinMint: mint, reason: why ?? "", action: hidden ? "hide" : "unhide", by: actor } }),
    audit(db, actor, hidden ? "hid coin" : "unhid coin", { mint, reason: why }),
  ]);
}

export const listExcluded = (db: PrismaClient) => db.excludedAccount.findMany({ orderBy: { createdAt: "desc" } });

/** Exclude an address from rewards, for every coin ("global") or one coin (its mint). */
export async function addExclusion(db: PrismaClient, address: string, scope: string, reason: string, note: string | null, actor: Actor): Promise<void> {
  if (!ADDRESS.test(address)) throw new AdminError("bad_request", "Enter a Solana address.");
  if (scope !== "global" && !ADDRESS.test(scope)) throw new AdminError("bad_request", "The scope must be a coin mint or global.");
  await db.$transaction([
    db.excludedAccount.upsert({
      where: { address_scope: { address, scope } },
      create: { address, scope, reason: reason.slice(0, 64), note: note?.slice(0, 200) ?? null, createdBy: actor },
      update: { reason: reason.slice(0, 64), note: note?.slice(0, 200) ?? null },
    }),
    audit(db, actor, "excluded account", { address, scope }),
  ]);
}

export async function removeExclusion(db: PrismaClient, address: string, scope: string, actor: Actor): Promise<number> {
  const [r] = await db.$transaction([db.excludedAccount.deleteMany({ where: { address, scope } }), audit(db, actor, "removed exclusion", { address, scope })]);
  return r.count;
}

/** Pause or resume buybacks or payouts, for everything ("global") or one coin. */
export async function setPaused(db: PrismaClient, kind: PauseKind, scope: string, paused: boolean, actor: Actor): Promise<void> {
  const log = audit(db, actor, `${paused ? "paused" : "resumed"} ${kind}`, { scope });
  if (scope === "global") {
    const key = SETTINGS[kind];
    await db.$transaction([db.setting.upsert({ where: { key }, create: { key, value: paused, updatedBy: actor }, update: { value: paused, updatedBy: actor } }), log]);
    return;
  }
  if (!(await db.coin.findUnique({ where: { mint: scope }, select: { mint: true } }))) throw new AdminError("not_found", "No such coin.");
  await db.$transaction([db.coin.update({ where: { mint: scope }, data: kind === "buybacks" ? { buybacksPaused: paused } : { payoutsPaused: paused } }), log]);
}

export const listClaims = (db: PrismaClient, limit = 20) => db.vaultClaim.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(limit, 200) });

/** Approve a vault claim held for a mismatch: the reconcile worker then sends its transfers. */
export async function approveHeldClaim(db: PrismaClient, id: string, actor: Actor): Promise<void> {
  const done = await db.$transaction(async (tx) => {
    const c = await tx.vaultClaim.findUnique({ where: { id } });
    if (!c) return false;
    const u = await tx.vaultClaim.updateMany({ where: { id, stage: "held" }, data: { stage: "transfer" } });
    if (u.count !== 1) return false;
    await audit(tx, actor, "approved held vault claim", { id, mismatchPpm: c.mismatchPpm, claimed: c.claimedLamports.toString(), expected: c.expectedLamports.toString() });
    return true;
  });
  if (!done) throw new AdminError("conflict", "Only held claims can be approved.");
}

/** Failed jobs and recent warnings. Failed buybacks and payouts were refunded/restored and retry by themselves. */
export async function failedJobs(db: PrismaClient, take = 20) {
  return {
    buybacks: await db.buyback.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take }),
    payoutItems: await db.payoutItem.findMany({ where: { status: "FAILED" }, take, include: { payout: { select: { coinMint: true, round: true, createdAt: true } } } }),
    claims: await db.vaultClaim.findMany({ where: { OR: [{ status: "FAILED" }, { stage: "held" }] }, orderBy: { createdAt: "desc" }, take }),
    harvests: await db.harvest.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take }),
    logs: await db.jobLog.findMany({ where: { level: { in: ["error", "alert", "warn"] } }, orderBy: { createdAt: "desc" }, take: 50 }),
  };
}

/** Re-queue a failed harvest (the harvest worker picks it up on its next run). */
export async function retryHarvest(db: PrismaClient, id: string, actor: Actor): Promise<void> {
  const done = await db.$transaction(async (tx) => {
    const u = await tx.harvest.updateMany({ where: { id, status: "FAILED" }, data: { createdAt: new Date(0) } });
    if (u.count !== 1) return false;
    await audit(tx, actor, "re-queued harvest", { id });
    return true;
  });
  if (!done) throw new AdminError("conflict", "Only failed harvests can be retried.");
}

export const listDeadLetters = (db: PrismaClient) => db.indexerDeadLetter.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, take: 100 });

/** Mark a dead-lettered signature as handled (after replaying or deciding it can be ignored). */
export async function resolveDeadLetter(db: PrismaClient, stream: string, signature: string, actor: Actor): Promise<void> {
  const done = await db.$transaction(async (tx) => {
    const u = await tx.indexerDeadLetter.updateMany({ where: { stream, signature, resolvedAt: null }, data: { resolvedAt: new Date() } });
    if (u.count !== 1) return false;
    await audit(tx, actor, "resolved indexer dead letter", { stream, signature });
    return true;
  });
  if (!done) throw new AdminError("not_found", "No open dead letter with that stream and signature.");
}

/** Recent admin actions (the audit log). */
export const auditLog = (db: PrismaClient, take = 50) => db.jobLog.findMany({ where: { job: "admin" }, orderBy: { createdAt: "desc" }, take });
