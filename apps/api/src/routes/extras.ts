/**
 * Extras: service status, Telegram payout alerts (holder bot), and the Helius
 * webhook that wakes the indexer early. None of these move funds.
 */
import { short } from "@backflow/core";
import type { PrismaClient } from "@backflow/db";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AuthError, SIGNED_BODY_SCHEMA, verifySigned, type AuthDeps } from "../auth";
import { cached } from "../cache";
import type { OnChain } from "../onchain";

export interface ExtrasDeps {
  db: PrismaClient | null;
  chain: OnChain | null;
  publish: ((channel: string, message: string) => Promise<unknown>) | null;
  mode: "mock" | "live";
  platformConfig: string | null;
  /** Signed-nonce auth (live mode). */
  auth?: AuthDeps | null;
}

/** Public status: ok/degraded per component only. Worker notes and other internals are only on the server (`pnpm admin overview`). */
export interface PublicStatus {
  status: "ok" | "degraded";
  api: "ok";
  mode: "mock" | "live";
  time: string;
  database?: "ok" | "down";
  /** Approximate seconds the indexer is behind the chain (slots × 0.4 s). */
  indexerLagSeconds?: number | null;
  lookupTable?: "ok" | "degraded";
  workers: Record<string, "ok" | "down">;
}

export const WAKE_CHANNEL = "backflow:indexer:wake";
const WORKERS = { indexer: 4101, buyback: 4102, payout: 4103, harvest: 4104, reconcile: 4105 } as const;

/** Constant-time comparison of two secrets of any length (compares sha256 digests, so lengths never throw). */
export const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const SLOT_SECONDS = 0.4;

async function tg(method: string, body: unknown): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal }).catch(() => {});
  clearTimeout(t);
}

export async function registerExtras(app: FastifyInstance, d: ExtrasDeps): Promise<void> {
  /** Public status page data (SPEC §10). Cached for 10 s: each refresh costs local HTTP calls, a query and an RPC call. */
  const statusC = cached<PublicStatus>(10_000);
  const loadStatus = async (): Promise<PublicStatus> => {
    const out: PublicStatus = { status: "ok", api: "ok", mode: d.mode, time: new Date().toISOString(), workers: {} };
    if (d.db) {
      try {
        await d.db.$queryRaw`SELECT 1`;
        out.database = "ok";
      } catch {
        out.database = "down";
      }
      if (d.platformConfig && d.chain) {
        const cur = await d.db.streamCursor.findUnique({ where: { stream: `platform:${d.platformConfig}` } }).catch(() => null);
        const slot = await d.chain.slot().catch(() => null);
        out.indexerLagSeconds = cur && slot ? Math.max(0, Math.round((slot - Number(cur.slot)) * SLOT_SECONDS)) : null;
      }
    }
    if (d.mode === "live" && d.chain) out.lookupTable = d.chain.lookupTable() === "ok" ? "ok" : "degraded";
    await Promise.all(
      Object.entries(WORKERS).map(async ([name, port]) => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 1000);
        try {
          const r = await fetch(`http://127.0.0.1:${process.env[`WORKER_${name.toUpperCase()}_PORT`] ?? port}/health`, { signal: ac.signal });
          const j = (await r.json()) as { healthy?: boolean };
          out.workers[name] = j.healthy ? "ok" : "down";
        } catch {
          out.workers[name] = "down";
        } finally {
          clearTimeout(t);
        }
      }),
    );
    if (out.database === "down" || out.lookupTable === "degraded" || (d.mode === "live" && Object.values(out.workers).some((w) => w !== "ok"))) out.status = "degraded";
    return out;
  };
  app.get("/status", async () => statusC(loadStatus));

  if (!d.db || d.mode !== "live") return;
  const db = d.db;

  const auth = d.auth;
  /** Step 1: the holder signs a single-use nonce ("telegram"); we return a one-time t.me link that binds their chat to the wallet. */
  app.post<{ Body: { wallet?: string; nonce?: string; signature?: string } }>("/telegram/link", { schema: SIGNED_BODY_SCHEMA, config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    if (!bot || !process.env.TELEGRAM_BOT_TOKEN || !auth) return reply.code(503).send({ error: "unavailable", message: "Telegram alerts aren't set up on this server." });
    let wallet: string;
    try {
      wallet = await verifySigned(auth, req.body, "telegram");
    } catch (e) {
      if (e instanceof AuthError) return reply.code(e.status).send({ error: e.code, message: e.message });
      throw e;
    }
    const code = randomBytes(12).toString("hex");
    await db.telegramLinkCode.create({ data: { code, wallet, expiresAt: new Date(Date.now() + 10 * 60_000) } });
    return { url: `https://t.me/${bot}?start=${code}` };
  });

  /** Step 2: Telegram calls this with /start <code> (secret token header set via setWebhook). */
  app.post<{ Body: { message?: { chat?: { id?: number }; text?: string } } }>("/telegram/webhook", async (req, reply) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    const got = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    if (!secret || !same(got, secret)) return reply.code(401).send({ ok: false });
    const chat = req.body?.message?.chat?.id;
    const text = (req.body?.message?.text ?? "").trim();
    if (!chat) return { ok: true };
    if (text.startsWith("/start ")) {
      const code = text.slice(7).trim();
      const row = await db.telegramLinkCode.findUnique({ where: { code } });
      if (!row || row.expiresAt < new Date()) {
        await tg("sendMessage", { chat_id: chat, text: "That link expired. Open the Rewards page and connect Telegram again." });
        return { ok: true };
      }
      await db.$transaction([
        db.telegramLink.upsert({ where: { wallet: row.wallet }, create: { wallet: row.wallet, chatId: String(chat) }, update: { chatId: String(chat) } }),
        db.telegramLinkCode.delete({ where: { code } }),
      ]);
      await tg("sendMessage", { chat_id: chat, text: `Linked to ${short(row.wallet)}. You'll get a message when a payout lands. Send /stop to turn this off.` });
    } else if (text === "/stop") {
      await db.telegramLink.deleteMany({ where: { chatId: String(chat) } });
      await tg("sendMessage", { chat_id: chat, text: "Payout alerts are off." });
    }
    return { ok: true };
  });

  /** Helius webhook: any activity → wake the indexer now instead of waiting for its next poll. */
  app.post("/webhooks/helius", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const secret = process.env.HELIUS_WEBHOOK_SECRET ?? "";
    const got = String(req.headers.authorization ?? "");
    if (!secret || secret.startsWith("REPLACE") || !same(got, secret)) return reply.code(401).send({ ok: false });
    await d.publish?.(WAKE_CHANNEL, String(Date.now()));
    return { ok: true };
  });
}
