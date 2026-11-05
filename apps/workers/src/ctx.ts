import { redactSecrets } from "@backflow/core";
/**
 * Shared worker context: database, live-event publisher, chain, alerts,
 * settings (pause switches) and the exclusion list.
 */
import type { LiveEvent } from "@backflow/core";
import type { PrismaClient } from "@backflow/db";
import type pino from "pino";
import type { Chain } from "./chain";

export interface Publisher {
  publish(e: LiveEvent): Promise<void>;
}

export interface Alerter {
  alert(kind: string, message: string, data?: Record<string, unknown>): Promise<void>;
}

export interface Ctx {
  db: PrismaClient;
  chain: Chain;
  live: Publisher;
  alerts: Alerter;
  log: pino.Logger;
  now: () => Date;
}

export const LIVE_CHANNEL = "backflow:live";

/** JSON that survives bigint. */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

/** Redis pub/sub publisher (API subscribes and fans out over WS /live). */
export function redisPublisher(redis: { publish(ch: string, msg: string): Promise<number> }): Publisher {
  return { publish: async (e) => void (await redis.publish(LIVE_CHANNEL, toJson(e))) };
}

/** Telegram alerts + JobLog row. Telegram is optional. */
export function makeAlerter(db: PrismaClient, log: pino.Logger, job: string): Alerter {
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID;
  const recent = new Map<string, number>();
  return {
    async alert(kind, rawMessage, data) {
      const message = redactSecrets(rawMessage); // RPC errors can quote the Helius URL with its key (audit)
      log.warn({ kind, ...data }, message);
      await db.jobLog.create({ data: { job, key: kind, level: "alert", message, data: data ? JSON.parse(toJson(data)) : undefined } }).catch(() => {});
      // de-duplicate the same alert for 10 minutes
      const last = recent.get(kind + message) ?? 0;
      if (Date.now() - last < 600_000) return;
      recent.set(kind + message, Date.now());
      if (!token || !chat) return;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: `⚠️ Backflow ${job}: ${message}` }),
      }).catch((e) => log.error({ err: e }, "telegram alert failed"));
    },
  };
}

export async function jobLog(db: PrismaClient, job: string, level: "info" | "warn" | "error", message: string, key?: string, data?: Record<string, unknown>) {
  await db.jobLog.create({ data: { job, key, level, message: redactSecrets(message), data: data ? JSON.parse(redactSecrets(toJson(data))) : undefined } }).catch(() => {});
}

/* -------------------------------- settings -------------------------------- */

export const SETTING = {
  buybacksPaused: "buybacks_paused",
  payoutsPaused: "payouts_paused",
  payoutRound: "payout_round",
} as const;

export async function getSetting<T>(db: PrismaClient, key: string, def: T): Promise<T> {
  const r = await db.setting.findUnique({ where: { key } });
  return r ? (r.value as T) : def;
}

export async function setSetting(db: PrismaClient, key: string, value: unknown, by = "system") {
  await db.setting.upsert({ where: { key }, create: { key, value: value as never, updatedBy: by }, update: { value: value as never, updatedBy: by } });
}

/* -------------------------------- exclusions ------------------------------- */

const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

/**
 * SPEC §3.2: wallets that hold tokens but never earn. Program-owned accounts
 * (curve vault, CPMM vaults) are already skipped by the indexer (off-curve owners).
 */
export async function excludedFor(ctx: Pick<Ctx, "db" | "chain">, coinMint: string): Promise<Set<string>> {
  const rows = await ctx.db.excludedAccount.findMany({ where: { scope: { in: ["global", coinMint] } } });
  const w = ctx.chain.wallets;
  return new Set([INCINERATOR, w.buyback, w.distributor, w.claim, w.treasury, w.lockNft, ...rows.map((r) => r.address)].filter(Boolean));
}

/** Seconds since epoch. */
export const sec = (d: Date) => Math.floor(d.getTime() / 1000);
