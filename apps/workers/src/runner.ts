import { redactSecrets } from "@backflow/core";
/**
 * Shared worker harness: one process per worker (CLAUDE.md), structured logs
 * (pino), a health endpoint, a tick loop that never overlaps itself, a
 * lease in the WorkerLease table so a second copy of the same worker can't run
 * (and can't double-spend), and graceful shutdown.
 *
 * The lease replaces a session advisory lock: that lock lived on one pooled
 * Prisma connection (silently lost if the pool recycled it, broken under
 * PgBouncer), and a second copy that missed it idled forever, which left the
 * worker stopped after `pm2 reload`. The lease is renewed every few seconds, a
 * waiting copy keeps retrying, and a lost lease stops new ticks.
 */
import { getPrisma, type PrismaClient } from "@backflow/db";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import pino from "pino";
import { RealChain } from "./chain";
import { makeAlerter, redisPublisher, type Ctx, type Publisher } from "./ctx";

export type WorkerName = "indexer" | "buyback" | "payout" | "harvest" | "reconcile";

export interface WorkerSpec {
  name: WorkerName;
  port?: number;
  intervalMs: number;
  tick: (ctx: Ctx) => Promise<void>;
  /** Redis channel that triggers an immediate tick (e.g. the Helius webhook for the indexer). */
  wakeChannel?: string;
}

const DEFAULT_PORTS: Record<WorkerName, number> = { indexer: 4101, buyback: 4102, payout: 4103, harvest: 4104, reconcile: 4105 };
export const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;

/** Take or renew the lease for `name`. True when `owner` holds it afterwards. */
export async function acquireLease(db: PrismaClient, name: string, owner: string, ttlMs = LEASE_TTL_MS): Promise<boolean> {
  const until = new Date(Date.now() + ttlMs);
  const rows = await db.$queryRaw<{ owner: string }[]>`
    INSERT INTO "WorkerLease" (name, owner, until, "updatedAt") VALUES (${name}, ${owner}, ${until}, now())
    ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, until = EXCLUDED.until, "updatedAt" = now()
    WHERE "WorkerLease".until < now() OR "WorkerLease".owner = EXCLUDED.owner
    RETURNING owner`;
  return rows[0]?.owner === owner;
}

export async function releaseLease(db: PrismaClient, name: string, owner: string): Promise<void> {
  await db.workerLease.deleteMany({ where: { name, owner } });
}

async function makePublisher(log: pino.Logger): Promise<Publisher> {
  const url = process.env.REDIS_URL;
  if (!url) {
    log.warn("REDIS_URL not set; live events are dropped");
    return { publish: async () => {} };
  }
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
  let lastErr = 0;
  redis.on("error", (e) => {
    if (Date.now() - lastErr < 60_000) return; // one line a minute, not one per retry
    lastErr = Date.now();
    log.error({ err: e }, "redis error (live events are not delivered; trading, buybacks and payouts are unaffected)");
  });
  return redisPublisher(redis, (e) => log.error({ err: e }, "live event not delivered (redis)"));
}

export function runWorker(spec: WorkerSpec): void {
  const log = pino({
    name: `worker:${spec.name}`,
    level: process.env.LOG_LEVEL ?? "info",
    // RPC errors can quote the Helius URL with its key: keep it out of the logs (audit)
    serializers: { err: (e: Error) => { const o = pino.stdSerializers.err(e); return { ...o, message: redactSecrets(o.message ?? ""), stack: redactSecrets(o.stack ?? "") }; } },
  });
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
  let leaseOwner: { db: PrismaClient; owner: string } | null = null;
  const runningRef = { running: false };

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
    const owner = hostname() + ":" + process.pid + ":" + randomBytes(4).toString("hex");
    leaseOwner = { db, owner };
    // wait for the lease (another copy may still be finishing, e.g. during pm2 reload)
    while (!stopping && !(await acquireLease(db, spec.name, owner).catch(() => false))) {
      if (!state.note) log.warn((state.note = "another process holds this worker's lease; waiting"));
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (stopping) return;
    state.locked = true;
    state.note = null;
    const renew = setInterval(() => {
      void acquireLease(db, spec.name, owner)
        .then((ok) => {
          if (!ok && state.locked) log.error("lost the worker lease; no new ticks");
          state.locked = ok;
        })
        .catch((e) => {
          state.locked = false;
          log.error({ err: e }, "could not renew the worker lease; no new ticks");
        });
    }, LEASE_RENEW_MS);
    renew.unref();
    const chain = new RealChain({
      platformConfig: platform,
      priorityMicroLamports: Number(process.env.PRIORITY_FEE_MICROLAMPORTS ?? 20_000),
      priceSource: process.env.SOL_USD_SOURCE === "jupiter" ? "jupiter" : "pyth",
    });
    const ctx: Ctx = { db, chain, live: await makePublisher(log), alerts: makeAlerter(db, log, spec.name), log, now: () => new Date() };
    let timer: NodeJS.Timeout | undefined;
    const loop = async () => {
      if (stopping || runningRef.running) return;
      if (!state.locked) {
        // lease lost: try to take it back before doing any work
        state.locked = await acquireLease(db, spec.name, owner).catch(() => false);
        if (!state.locked) {
          timer = setTimeout(() => void loop(), spec.intervalMs);
          return;
        }
      }
      clearTimeout(timer);
      runningRef.running = true;
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
        runningRef.running = false;
      }
      if (!stopping) timer = setTimeout(() => void loop(), spec.intervalMs);
    };
    void loop();
    if (spec.wakeChannel && process.env.REDIS_URL) {
      const { default: Redis } = await import("ioredis");
      const sub = new Redis(process.env.REDIS_URL);
      let lastSubErr = 0;
      sub.on("error", (e) => {
        if (Date.now() - lastSubErr < 60_000) return;
        lastSubErr = Date.now();
        log.error({ err: e }, "redis wake subscriber error (the worker still runs on its timer)");
      });
      await sub.subscribe(spec.wakeChannel).catch((e: unknown) => log.error({ err: e }, "redis wake subscribe failed (the worker still runs on its timer)"));
      let last = 0;
      sub.on("message", () => {
        // debounce: at most one early tick per second
        if (Date.now() - last < 1000) return;
        last = Date.now();
        void loop();
      });
    }
  })().catch((e) => {
    state.lastError = (e as Error).message;
    log.error({ err: e }, "worker failed to start");
  });

  const stop = (signal: string) => {
    log.info({ signal }, "stopping: no new ticks; the lease is released after the current tick");
    stopping = true;
    server.close();
    // Every job records its signature before broadcasting, so an interrupted tick is recovered on the
    // next start; still give a running tick up to 10 s to finish before releasing the lease.
    const exit = () => {
      const l = leaseOwner;
      void (l ? releaseLease(l.db, spec.name, l.owner).catch(() => {}) : Promise.resolve()).finally(() => process.exit(0));
    };
    const started = Date.now();
    const wait = setInterval(() => {
      if (!runningRef.running || Date.now() - started > 10_000) {
        clearInterval(wait);
        exit();
      }
    }, 100);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}
