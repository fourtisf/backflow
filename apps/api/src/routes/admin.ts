/**
 * Admin API (SPEC §5.6, §10): wallet allowlist + signed sign-in, moderation,
 * exclusions, pause switches, hot-wallet balances, reconciliation report,
 * failed jobs and retries. Every write is logged to JobLog with the admin
 * wallet, in the same database transaction as the change.
 *
 * Sign-in (audit M5): POST /auth/nonce {wallet, purpose: "admin"}, sign
 * signInMessage(...) (domain, cluster, purpose, single-use nonce), then
 * POST /admin/session {wallet, nonce, signature} -> a random bearer token.
 * Only its sha256 is stored (AdminSession), it expires after 30 minutes and
 * POST /admin/logout revokes it. Send it as `authorization: Bearer <token>`.
 *
 * Approving a held vault claim and resuming buybacks or payouts need a session
 * signed in within the last 5 minutes; otherwise the API answers 401
 * `fresh_sign_in_required` and the web asks the admin to sign again.
 */
import { looksLikeAddress } from "@backflow/core";
import { Prisma, type PrismaClient } from "@backflow/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthError, SIGNED_BODY_SCHEMA, newToken, sha256, verifySigned, type AuthDeps } from "../auth";
import type { OnChain } from "../onchain";

export const ADMIN_SESSION_TTL_MS = 30 * 60_000;
export const ADMIN_FRESH_MS = 5 * 60_000;

export interface AdminDeps {
  db: PrismaClient;
  chain: OnChain | null;
  admins: Set<string>;
  wallets: { buyback: string; distributor: string; claim: string; treasury: string };
  platformConfig: string;
  auth: AuthDeps;
}

interface AdminCtx {
  wallet: string;
  signedInAt: Date;
  tokenHash: string;
}
type AdminReq = FastifyRequest & { admin?: AdminCtx };

const SETTINGS = { buybacks: "buybacks_paused", payouts: "payouts_paused" } as const;
const str = (max: number) => ({ type: "string", maxLength: max }) as const;
const ADDR = str(64);

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t.length >= 20 && t.length <= 100 ? t : null;
}

const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: "unauthorized", message: "Sign in with an admin wallet." });
const needFresh = (reply: FastifyReply) => reply.code(401).send({ error: "fresh_sign_in_required", message: "Sign in again to confirm this action." });

export async function registerAdmin(app: FastifyInstance, d: AdminDeps): Promise<void> {
  const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  const who = (req: FastifyRequest) => (req as AdminReq).admin!.wallet;
  const fresh = (req: FastifyRequest) => Date.now() - (req as AdminReq).admin!.signedInAt.getTime() <= ADMIN_FRESH_MS;
  const auditRow = (req: FastifyRequest, message: string, data?: Record<string, unknown>) =>
    d.db.jobLog.create({ data: { job: "admin", key: who(req), level: "info", message, data: data as never } });

  /** Sign in: exchange a signed admin nonce for a session token. The allowlist is checked before the signature. */
  app.post<{ Body: { wallet?: string; nonce?: string; signature?: string } }>(
    "/admin/session",
    { schema: SIGNED_BODY_SCHEMA, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const wallet = req.body?.wallet;
      const fail = async (reason: string) => {
        req.log.warn({ wallet: typeof wallet === "string" ? wallet.slice(0, 64) : null, ip: req.ip, reason }, "failed admin sign-in");
        if (typeof wallet === "string" && d.admins.has(wallet)) {
          await d.db.jobLog.create({ data: { job: "admin", key: wallet, level: "warn", message: "failed admin sign-in", data: { reason, ip: req.ip } } }).catch(() => {});
        }
        return unauthorized(reply);
      };
      if (typeof wallet !== "string" || !looksLikeAddress(wallet) || !d.admins.has(wallet)) return fail("not on the admin list");
      try {
        await verifySigned(d.auth, req.body, "admin");
      } catch (e) {
        if (e instanceof AuthError) return fail(e.code);
        throw e;
      }
      const token = newToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
      await d.db.$transaction([
        d.db.adminSession.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } }),
        d.db.adminSession.create({ data: { tokenHash: sha256(token), wallet, createdAt: now, expiresAt } }),
        d.db.jobLog.create({ data: { job: "admin", key: wallet, level: "info", message: "admin signed in", data: { ip: req.ip } } }),
      ]);
      return { token, wallet, expiresAt: expiresAt.toISOString() };
    },
  );

  await app.register(async (r) => {
    // onRequest: reject before the body is parsed (audit M5)
    r.addHook("onRequest", async (req, reply) => {
      const token = bearer(req);
      if (!token) return unauthorized(reply);
      const tokenHash = sha256(token);
      const s = await d.db.adminSession.findUnique({ where: { tokenHash } });
      if (!s || s.revokedAt || s.expiresAt <= new Date() || !d.admins.has(s.wallet)) return unauthorized(reply);
      (req as AdminReq).admin = { wallet: s.wallet, signedInAt: s.createdAt, tokenHash };
    });

    r.post("/admin/logout", async (req) => {
      const a = (req as AdminReq).admin!;
      await d.db.$transaction([d.db.adminSession.update({ where: { tokenHash: a.tokenHash }, data: { revokedAt: new Date() } }), auditRow(req, "admin signed out")]);
      return { ok: true };
    });

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
        lookupTable: d.chain ? d.chain.lookupTable() : null,
        buybackBudgets: budgets._sum.buybackBudget ?? 0n,
        unclaimedPlatformFees: unclaimed._sum.platformFee ?? 0n,
        unclaimedHoldersPart: unclaimed._sum.holdersPart ?? 0n,
        failed,
      });
    });

    r.get("/admin/coins", async () => {
      const coins = await d.db.coin.findMany({ orderBy: { createdAt: "desc" }, take: 200, select: { mint: true, name: true, ticker: true, hidden: true, hiddenReason: true, launchedViaUs: true, status: true, buybacksPaused: true, payoutsPaused: true, buybackBudget: true, createdAt: true } });
      // distinct reporters per coin, so one reporter can't bury real reports by repeating themselves
      const reports = await d.db.$queryRaw<{ coinMint: string; n: number }[]>(Prisma.sql`
        SELECT "coinMint", COUNT(DISTINCT "by")::int AS n FROM "ModerationFlag" WHERE action = 'report' GROUP BY "coinMint"`);
      const n = new Map(reports.map((x) => [x.coinMint, Number(x.n)]));
      return json(coins.map((c) => ({ ...c, reports: n.get(c.mint) ?? 0 })).sort((a, b) => b.reports - a.reports || 0));
    });

    r.get<{ Params: { mint: string } }>("/admin/coins/:mint/reports", async (req) => json(await d.db.moderationFlag.findMany({ where: { coinMint: req.params.mint.slice(0, 64), action: "report" }, orderBy: { createdAt: "desc" }, take: 100 })));

    r.post<{ Params: { mint: string }; Body: { hidden?: boolean; reason?: string } }>(
      "/admin/coins/:mint/hide",
      { schema: { body: { type: "object", properties: { hidden: { type: "boolean" }, reason: str(200) } } } },
      async (req, reply) => {
        const c = await d.db.coin.findUnique({ where: { mint: req.params.mint.slice(0, 64) } });
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
          d.db.moderationFlag.create({ data: { coinMint: c.mint, reason: reason ?? "", action: hidden ? "hide" : "unhide", by: who(req) } }),
          auditRow(req, hidden ? "hid coin" : "unhid coin", { mint: c.mint, reason }),
        ]);
        return { ok: true };
      },
    );

    r.get("/admin/excluded", async () => json(await d.db.excludedAccount.findMany({ orderBy: { createdAt: "desc" } })));
    r.post<{ Body: { address?: string; scope?: string; reason?: string; note?: string } }>(
      "/admin/excluded",
      { schema: { body: { type: "object", properties: { address: ADDR, scope: ADDR, reason: str(64), note: str(200) } } } },
      async (req, reply) => {
        const b = req.body ?? {};
        if (!b.address || !looksLikeAddress(b.address)) return reply.code(400).send({ error: "bad_request", message: "Enter a Solana address." });
        const scope = b.scope && b.scope !== "global" ? b.scope : "global";
        if (scope !== "global" && !looksLikeAddress(scope)) return reply.code(400).send({ error: "bad_request", message: "Enter a coin mint, or leave it empty for all coins." });
        await d.db.$transaction([
          d.db.excludedAccount.upsert({ where: { address_scope: { address: b.address, scope } }, create: { address: b.address, scope, reason: b.reason ?? "manual", note: b.note ?? null, createdBy: who(req) }, update: { reason: b.reason ?? "manual", note: b.note ?? null } }),
          auditRow(req, "excluded account", { address: b.address, scope }),
        ]);
        return { ok: true };
      },
    );
    r.delete<{ Querystring: { address?: string; scope?: string } }>("/admin/excluded", async (req) => {
      const address = String(req.query.address ?? "").slice(0, 64);
      const scope = String(req.query.scope ?? "global").slice(0, 64);
      await d.db.$transaction([d.db.excludedAccount.deleteMany({ where: { address, scope } }), auditRow(req, "removed exclusion", { address, scope })]);
      return { ok: true };
    });

    r.post<{ Body: { kind?: "buybacks" | "payouts"; scope?: string; paused?: boolean } }>(
      "/admin/pause",
      { schema: { body: { type: "object", properties: { kind: str(16), scope: ADDR, paused: { type: "boolean" } } } } },
      async (req, reply) => {
        const b = req.body ?? {};
        if (b.kind !== "buybacks" && b.kind !== "payouts") return reply.code(400).send({ error: "bad_request", message: "kind must be buybacks or payouts" });
        const paused = b.paused !== false;
        // Resuming money movement is sensitive: it needs a fresh sign-in.
        if (!paused && !fresh(req)) return needFresh(reply);
        const scope = b.scope && b.scope !== "global" ? b.scope : "global";
        const log = auditRow(req, `${paused ? "paused" : "resumed"} ${b.kind}`, { scope });
        if (scope === "global") {
          const key = SETTINGS[b.kind];
          await d.db.$transaction([d.db.setting.upsert({ where: { key }, create: { key, value: paused, updatedBy: who(req) }, update: { value: paused, updatedBy: who(req) } }), log]);
        } else {
          if (!(await d.db.coin.findUnique({ where: { mint: scope }, select: { mint: true } }))) return reply.code(404).send({ error: "not_found", message: "No such coin." });
          await d.db.$transaction([d.db.coin.update({ where: { mint: scope }, data: b.kind === "buybacks" ? { buybacksPaused: paused } : { payoutsPaused: paused } }), log]);
        }
        return { ok: true };
      },
    );

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
     * tick. The manual actions are approving a claim held for a mismatch (it moves on to the transfers; needs a
     * fresh sign-in) and re-queueing a failed harvest.
     */
    r.post<{ Body: { kind?: string; id?: string } }>("/admin/retry", { schema: { body: { type: "object", properties: { kind: str(16), id: str(64) } } } }, async (req, reply) => {
      const b = req.body ?? {};
      if (b.kind === "claim" && b.id) {
        if (!fresh(req)) return needFresh(reply);
        const c = await d.db.vaultClaim.findUnique({ where: { id: b.id } });
        if (!c || c.stage !== "held") return reply.code(409).send({ error: "conflict", message: "Only held claims can be approved." });
        const done = await d.db.$transaction(async (tx) => {
          const u = await tx.vaultClaim.updateMany({ where: { id: b.id, stage: "held" }, data: { stage: "transfer" } });
          if (u.count !== 1) return false;
          await tx.jobLog.create({ data: { job: "admin", key: who(req), level: "info", message: "approved held vault claim", data: { id: b.id, mismatchPpm: c.mismatchPpm } } });
          return true;
        });
        if (!done) return reply.code(409).send({ error: "conflict", message: "Only held claims can be approved." });
        return { ok: true, note: "The reconcile worker sends the transfers on its next run. Resume buybacks when you're satisfied." };
      }
      if (b.kind === "harvest" && b.id) {
        const h = await d.db.harvest.findUnique({ where: { id: b.id } });
        if (!h || h.status !== "FAILED") return reply.code(409).send({ error: "conflict", message: "Only failed harvests can be retried." });
        const done = await d.db.$transaction(async (tx) => {
          const u = await tx.harvest.updateMany({ where: { id: b.id, status: "FAILED" }, data: { createdAt: new Date(0) } });
          if (u.count !== 1) return false;
          await tx.jobLog.create({ data: { job: "admin", key: who(req), level: "info", message: "re-queued harvest", data: { id: b.id } } });
          return true;
        });
        if (!done) return reply.code(409).send({ error: "conflict", message: "Only failed harvests can be retried." });
        return { ok: true };
      }
      return { ok: true, note: "Failed buybacks and payouts were refunded and retry automatically." };
    });
  });
}
