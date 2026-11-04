/**
 * Extras: service status, Telegram payout alerts (holder bot), and the Helius
 * webhook that wakes the indexer early. None of these move funds.
 */
import { telegramLinkMessage, looksLikeAddress, short } from "@backflow/core";
import type { PrismaClient } from "@backflow/db";
import bs58 from "bs58";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import type { OnChain } from "../onchain";

export interface ExtrasDeps {
  db: PrismaClient | null;
  chain: OnChain | null;
  publish: ((channel: string, message: string) => Promise<unknown>) | null;
  mode: "mock" | "live";
  platformConfig: string | null;
}

export const WAKE_CHANNEL = "backflow:indexer:wake";
const WORKERS = { indexer: 4101, buyback: 4102, payout: 4103, harvest: 4104, reconcile: 4105 } as const;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function tg(method: string, body: unknown): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal }).catch(() => {});
  clearTimeout(t);
}

export async function registerExtras(app: FastifyInstance, d: ExtrasDeps): Promise<void> {
  /** Public status page data (SPEC §10). */
  app.get("/status", async () => {
    const out: Record<string, unknown> = { api: "ok", mode: d.mode, time: new Date().toISOString() };
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
        out.indexerLagSlots = cur && slot ? slot - Number(cur.slot) : null;
      }
    }
    const workers: Record<string, unknown> = {};
    for (const [name, port] of Object.entries(WORKERS)) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 1000);
      try {
        const r = await fetch(`http://127.0.0.1:${process.env[`WORKER_${name.toUpperCase()}_PORT`] ?? port}/health`, { signal: ac.signal });
        const j = (await r.json()) as { healthy?: boolean; lastOkAt?: string | null; note?: string | null };
        workers[name] = { healthy: !!j.healthy, lastOkAt: j.lastOkAt ?? null, note: j.note ?? null };
      } catch {
        workers[name] = { healthy: false, lastOkAt: null, note: "not reachable" };
      } finally {
        clearTimeout(t);
      }
    }
    out.workers = workers;
    return out;
  });

  if (!d.db || d.mode !== "live") return;
  const db = d.db;

  /** Step 1: the holder signs a message; we return a one-time t.me link that binds their chat to the wallet. */
  app.post<{ Body: { wallet?: string; issuedAt?: number; signature?: string } }>("/telegram/link", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    if (!bot || !process.env.TELEGRAM_BOT_TOKEN) return reply.code(503).send({ error: "unavailable", message: "Telegram alerts aren't set up on this server." });
    const { wallet, issuedAt, signature } = req.body ?? {};
    if (!wallet || !looksLikeAddress(wallet) || typeof issuedAt !== "number" || !signature) return reply.code(400).send({ error: "bad_request", message: "Sign the message in your wallet first." });
    if (Math.abs(Date.now() - issuedAt) > 10 * 60_000) return reply.code(400).send({ error: "expired", message: "That signature expired. Try again." });
    let ok = false;
    try {
      ok = nacl.sign.detached.verify(new TextEncoder().encode(telegramLinkMessage(wallet, issuedAt)), bs58.decode(signature), bs58.decode(wallet));
    } catch {
      ok = false;
    }
    if (!ok) return reply.code(401).send({ error: "bad_signature", message: "That signature doesn't match the wallet." });
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
