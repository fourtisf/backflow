/**
 * Admin API (SPEC §5.6, §10): wallet allowlist + signature auth, moderation,
 * exclusions, pause switches, hot-wallet balances, reconciliation report,
 * failed jobs and retries. Every write is logged to JobLog with the admin wallet.
 *
 * Auth header: x-admin-auth: <wallet>.<issuedAtMs>.<base58 signature>
 * over the message adminMessage(wallet, issuedAtMs). Valid for 15 minutes.
 */
import { ADMIN_TTL_MS, adminMessage, looksLikeAddress } from "@backflow/core";
import type { PrismaClient } from "@backflow/db";
import bs58 from "bs58";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import nacl from "tweetnacl";
import type { OnChain } from "../onchain";

export { ADMIN_TTL_MS, adminMessage };

/** Returns the admin wallet, or null when the header is missing, expired, forged or not allowlisted. */
export function verifyAdmin(header: string | undefined, allow: Set<string>, now = Date.now()): string | null {
  if (!header) return null;
  const [wallet, ts, sig] = header.split(".");
  if (!wallet || !ts || !sig || !looksLikeAddress(wallet) || !allow.has(wallet)) return null;
  const issued = Number(ts);
  if (!Number.isFinite(issued) || issued > now + 60_000 || now - issued > ADMIN_TTL_MS) return null;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(adminMessage(wallet, issued)), bs58.decode(sig), bs58.decode(wallet)) ? wallet : null;
  } catch {
    return null;
  }
}

export interface AdminDeps {
  db: PrismaClient;
  chain: OnChain | null;
  admins: Set<string>;
  wallets: { buyback: string; distributor: string; claim: string; treasury: string };
  platformConfig: string;
}

const SETTINGS = { buybacks: "buybacks_paused", payouts: "payouts_paused" } as const;

export async function registerAdmin(app: FastifyInstance, d: AdminDeps): Promise<void> {
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    const who = verifyAdmin(req.headers["x-admin-auth"] as string | undefined, d.admins);
    if (!who) return reply.code(401).send({ error: "unauthorized", message: "Sign in with an admin wallet." });
    (req as FastifyRequest & { admin: string }).admin = who;
  };
  const audit = (req: FastifyRequest, message: string, data?: Record<string, unknown>) =>
    d.db.jobLog.create({ data: { job: "admin", key: (req as FastifyRequest & { admin?: string }).admin, level: "info", message, data: data as never } });
  const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

  await app.register(async (r) => {
    r.addHook("preHandler", guard);

    r.get("/admin/overview", async () => {
      const settings = Object.fromEntries((await d.db.setting.findMany()).map((s) => [s.key, s.value]));
      const balances: Record<string, string | null> = {};
      for (const [name, addr] of Object.entries(d.wallets)) balances[name] = addr && d.chain ? (await d.chain.walletSol(addr).catch(() => null))?.toString() ?? null : null;
      const cursor = await d.db.streamCursor.findUnique({ where: { stream: `platform:${d.platformConfig}` } });
      const slot = d.chain ? await d.chain.slot().catch(() => null) : null;
      const budgets = await d.db.coin.aggregate({ _sum: { buybackBudget: true } });
      const unclaimed = await d.db.feeAccrual.aggregate({ where: { claimId: null }, _sum: { platformFee: true, holdersPart: true } });
      const dayAgo = new Date(Date.now() - 86_400_000);
      const failed = {
        buybacks: await d.db.buyback.count({ where: { status: "FAILED", createdAt: { gte: dayAgo } } }),
        payoutItems: await d.db.payoutItem.count({ where: { status: "FAILED", payout: { createdAt: { gte: dayAgo } } } }),
        claims: await d.db.vaultClaim.count({ where: { OR: [{ status: "FAILED" }, { stage: "held" }], createdAt: { gte: dayAgo } } }),
        harvests: await d.db.harvest.count({ where: { status: "FAILED", createdAt: { gte: dayAgo } } }),
      };
      return json({
        settings,
        wallets: d.wallets,
        balances,
        indexer: { slot: cursor?.slot ?? null, chainSlot: slot, lagSlots: cursor && slot ? slot - Number(cursor.slot) : null },
        buybackBudgets: budgets._sum.buybackBudget ?? 0n,
        unclaimedPlatformFees: unclaimed._sum.platformFee ?? 0n,
        unclaimedHoldersPart: unclaimed._sum.holdersPart ?? 0n,
        failed,
      });
    });

    r.get("/admin/coins", async () => json(await d.db.coin.findMany({ orderBy: { createdAt: "desc" }, take: 200, select: { mint: true, name: true, ticker: true, hidden: true, hiddenReason: true, launchedViaUs: true, status: true, buybacksPaused: true, payoutsPaused: true, buybackBudget: true, createdAt: true } })));

    r.post<{ Params: { mint: string }; Body: { hidden?: boolean; reason?: string } }>("/admin/coins/:mint/hide", async (req, reply) => {
      const c = await d.db.coin.findUnique({ where: { mint: req.params.mint } });
      if (!c) return reply.code(404).send({ error: "not_found", message: "No such coin." });
      const hidden = req.body?.hidden !== false;
      const reason = (req.body?.reason ?? "").slice(0, 200) || null;
      // Unhiding a duplicate-ticker coin is refused while another coin owns the ticker.
      if (!hidden && !c.tickerSlot) {
        const owner = await d.db.coin.findUnique({ where: { tickerSlot: c.tickerKey } });
        if (owner && owner.mint !== c.mint) return reply.code(409).send({ error: "ticker_taken", message: `$${c.ticker} is already used by another coin.` });
      }
      await d.db.$transaction([
        d.db.coin.update({ where: { mint: c.mint }, data: { hidden, hiddenReason: hidden ? reason : null, ...(!hidden && !c.tickerSlot ? { tickerSlot: c.tickerKey } : {}) } }),
        d.db.moderationFlag.create({ data: { coinMint: c.mint, reason: reason ?? "", action: hidden ? "hide" : "unhide", by: (req as FastifyRequest & { admin: string }).admin } }),
      ]);
      await audit(req, hidden ? "hid coin" : "unhid coin", { mint: c.mint, reason });
      return { ok: true };
    });

    r.get("/admin/excluded", async () => json(await d.db.excludedAccount.findMany({ orderBy: { createdAt: "desc" } })));
    r.post<{ Body: { address?: string; scope?: string; reason?: string; note?: string } }>("/admin/excluded", async (req, reply) => {
      const b = req.body ?? {};
      if (!b.address || !looksLikeAddress(b.address)) return reply.code(400).send({ error: "bad_request", message: "Enter a Solana address." });
      const scope = b.scope && b.scope !== "global" ? b.scope : "global";
      await d.db.excludedAccount.upsert({ where: { address_scope: { address: b.address, scope } }, create: { address: b.address, scope, reason: b.reason ?? "manual", note: b.note ?? null, createdBy: (req as FastifyRequest & { admin: string }).admin }, update: { reason: b.reason ?? "manual", note: b.note ?? null } });
      await audit(req, "excluded account", { address: b.address, scope });
      return { ok: true };
    });
    r.delete<{ Querystring: { address?: string; scope?: string } }>("/admin/excluded", async (req) => {
      await d.db.excludedAccount.deleteMany({ where: { address: req.query.address ?? "", scope: req.query.scope ?? "global" } });
      await audit(req, "removed exclusion", { address: req.query.address, scope: req.query.scope });
      return { ok: true };
    });

    r.post<{ Body: { kind?: "buybacks" | "payouts"; scope?: string; paused?: boolean } }>("/admin/pause", async (req, reply) => {
      const b = req.body ?? {};
      if (b.kind !== "buybacks" && b.kind !== "payouts") return reply.code(400).send({ error: "bad_request", message: "kind must be buybacks or payouts" });
      const paused = b.paused !== false;
      if (!b.scope || b.scope === "global") {
        const key = SETTINGS[b.kind];
        await d.db.setting.upsert({ where: { key }, create: { key, value: paused, updatedBy: (req as FastifyRequest & { admin: string }).admin }, update: { value: paused, updatedBy: (req as FastifyRequest & { admin: string }).admin } });
      } else {
        await d.db.coin.update({ where: { mint: b.scope }, data: b.kind === "buybacks" ? { buybacksPaused: paused } : { payoutsPaused: paused } });
      }
      await audit(req, `${paused ? "paused" : "resumed"} ${b.kind}`, { scope: b.scope ?? "global" });
      return { ok: true };
    });

    r.get("/admin/reconcile", async () => json(await d.db.vaultClaim.findMany({ orderBy: { createdAt: "desc" }, take: 50 })));

    r.get("/admin/failed", async () => {
      const take = 50;
      return json({
        buybacks: await d.db.buyback.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take }),
        payoutItems: await d.db.payoutItem.findMany({ where: { status: "FAILED" }, take, include: { payout: { select: { coinMint: true, round: true, createdAt: true } } } }),
        claims: await d.db.vaultClaim.findMany({ where: { OR: [{ status: "FAILED" }, { stage: "held" }] }, orderBy: { createdAt: "desc" }, take }),
        harvests: await d.db.harvest.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take }),
        logs: await d.db.jobLog.findMany({ where: { level: { in: ["error", "alert", "warn"] } }, orderBy: { createdAt: "desc" }, take: 100 }),
      });
    });

    /**
     * Retry: failed buybacks and payouts were already refunded/restored and retry by themselves on the next
     * tick. The one manual action is approving a claim held for a mismatch: it moves on to the transfers.
     */
    r.post<{ Body: { kind?: string; id?: string } }>("/admin/retry", async (req, reply) => {
      const b = req.body ?? {};
      if (b.kind === "claim" && b.id) {
        const c = await d.db.vaultClaim.findUnique({ where: { id: b.id } });
        if (!c || c.stage !== "held") return reply.code(409).send({ error: "conflict", message: "Only held claims can be approved." });
        await d.db.vaultClaim.update({ where: { id: b.id }, data: { stage: "transfer" } });
        await audit(req, "approved held vault claim", { id: b.id, mismatchPpm: c.mismatchPpm });
        return { ok: true, note: "The reconcile worker sends the transfers on its next run. Resume buybacks when you're satisfied." };
      }
      if (b.kind === "harvest" && b.id) {
        await d.db.harvest.update({ where: { id: b.id }, data: { createdAt: new Date(0) } });
        await audit(req, "re-queued harvest", { id: b.id });
        return { ok: true };
      }
      return { ok: true, note: "Failed buybacks and payouts were refunded and retry automatically." };
    });
  });
}
