/**
 * Shared worker harness: one process per worker (CLAUDE.md), structured logs
 * (pino), a health endpoint, a tick loop that never overlaps itself, and
 * graceful shutdown. Each worker supplies `tick()`.
 */
import { createServer } from "node:http";
import pino from "pino";

export interface WorkerSpec {
  name: "indexer" | "buyback" | "payout" | "harvest" | "reconcile";
  /** Health port. Defaults to WORKER_<NAME>_PORT or the table below. */
  port?: number;
  intervalMs: number;
  /** Milestone that implements the real job; reported by /health until then. */
  milestone: number;
  tick: (ctx: TickContext) => Promise<void>;
}

export interface TickContext {
  log: pino.Logger;
  signal: AbortSignal;
}

const DEFAULT_PORTS: Record<WorkerSpec["name"], number> = {
  indexer: 4101,
  buyback: 4102,
  payout: 4103,
  harvest: 4104,
  reconcile: 4105,
};

export function runWorker(spec: WorkerSpec): void {
  const log = pino({ name: `worker:${spec.name}`, level: process.env.LOG_LEVEL ?? "info" });
  const port = spec.port ?? Number(process.env[`WORKER_${spec.name.toUpperCase()}_PORT`] ?? DEFAULT_PORTS[spec.name]);
  const ac = new AbortController();
  const state = {
    startedAt: new Date().toISOString(),
    lastTickAt: null as string | null,
    lastOkAt: null as string | null,
    lastError: null as string | null,
    ticks: 0,
    running: false,
  };

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const healthy = state.lastError == null;
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ worker: spec.name, healthy, implementedIn: `milestone ${spec.milestone}`, ...state }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1", () => log.info({ port }, "health endpoint listening"));

  let timer: NodeJS.Timeout | undefined;
  const loop = async () => {
    if (ac.signal.aborted) return;
    if (!state.running) {
      state.running = true;
      state.lastTickAt = new Date().toISOString();
      try {
        await spec.tick({ log, signal: ac.signal });
        state.lastOkAt = new Date().toISOString();
        state.lastError = null;
      } catch (e) {
        state.lastError = (e as Error).message;
        log.error({ err: e }, "tick failed");
      } finally {
        state.ticks++;
        state.running = false;
      }
    }
    timer = setTimeout(loop, spec.intervalMs);
  };
  void loop();

  const stop = (signal: string) => {
    log.info({ signal }, "stopping");
    ac.abort();
    clearTimeout(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}
