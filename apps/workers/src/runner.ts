/**
 * Shared worker harness: one process per worker (CLAUDE.md), structured logs
 * (pino), a health endpoint, a tick loop that never overlaps itself, a
 * Postgres advisory lock so a second copy of the same worker can't run (and
 * can't double-spend), and graceful shutdown.
 */
import { getPrisma } from "@backflow/db";
import { createServer } from "node:http";
import pino from "pino";
import { RealChain } from "./chain";
import { makeAlerter, redisPublisher, type Ctx, type Publisher } from "./ctx";

export type WorkerName = "indexer" | "buyback" | "payout" | "harvest" | "reconcile";

export interface WorkerSpec {
  name: WorkerName;
  port?: number;
  intervalMs: number;
  tick: (ctx: Ctx) => Promise<void>;
}

const DEFAULT_PORTS: Record<WorkerName, number> = { indexer: 4101, buyback: 4102, payout: 4103, harvest: 4104, reconcile: 4105 };
const LOCK_IDS: Record<WorkerName, number> = { indexer: 71001, buyback: 71002, payout: 71003, harvest: 71004, reconcile: 71005 };

async function makePublisher(log: pino.Logger): Promise<Publisher> {
  const url = process.env.REDIS_URL;
  if (!url) {
    log.warn("REDIS_URL not set; live events are dropped");
    return { publish: async () => {} };
  }
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
  redis.on("error", (e) => log.error({ err: e }, "redis error"));
  return redisPublisher(redis);
}

export function runWorker(spec: WorkerSpec): void {
  const log = pino({ name: `worker:${spec.name}`, level: process.env.LOG_LEVEL ?? "info" });
  const port = spec.port ?? Number(process.env[`WORKER_${spec.name.toUpperCase()}_PORT`] ?? DEFAULT_PORTS[spec.name]);
  const state = {
    startedAt: new Date().toISOString(),
    configured: false,
    locked: false,
    lastTickAt: null as string | null,
    lastOkAt: null as string | null,
    lastError: null as string | null,
    ticks: 0,
    note: null as string | null,
  };
  let stopping = false;

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const healthy = state.lastError == null && (state.locked || !state.configured);
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ worker: spec.name, healthy, ...state }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1", () => log.info({ port }, "health endpoint listening"));

  void (async () => {
    const platform = process.env.PLATFORM_CONFIG_PUBKEY;
    if (!platform || platform.startsWith("REPLACE") || !process.env.DATABASE_URL) {
      state.note = "not configured: set PLATFORM_CONFIG_PUBKEY and DATABASE_URL (run pnpm platform:create first)";
      log.warn(state.note);
      return;
    }
    state.configured = true;
    const db = getPrisma();
    const rows = await db.$queryRawUnsafe<{ locked: boolean }[]>(`SELECT pg_try_advisory_lock(${LOCK_IDS[spec.name]}) AS locked`);
    const locked = rows[0]?.locked === true;
    if (!locked) {
      state.note = "another process already runs this worker; idling";
      log.error(state.note);
      return;
    }
    state.locked = true;
    const chain = new RealChain({
      platformConfig: platform,
      priorityMicroLamports: Number(process.env.PRIORITY_FEE_MICROLAMPORTS ?? 20_000),
      priceSource: process.env.SOL_USD_SOURCE === "jupiter" ? "jupiter" : "pyth",
    });
    const ctx: Ctx = { db, chain, live: await makePublisher(log), alerts: makeAlerter(db, log, spec.name), log, now: () => new Date() };
    const loop = async () => {
      if (stopping) return;
      state.lastTickAt = new Date().toISOString();
      try {
        await spec.tick(ctx);
        state.lastOkAt = new Date().toISOString();
        state.lastError = null;
      } catch (e) {
        state.lastError = (e as Error).message;
        log.error({ err: e }, "tick failed");
      } finally {
        state.ticks++;
      }
      if (!stopping) setTimeout(loop, spec.intervalMs);
    };
    void loop();
  })().catch((e) => {
    state.lastError = (e as Error).message;
    log.error({ err: e }, "worker failed to start");
  });

  const stop = (signal: string) => {
    log.info({ signal }, "stopping after the current tick");
    stopping = true;
    server.close();
    setTimeout(() => process.exit(0), 10_000).unref();
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}
