import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { looksLikeAddress, type BoardTab, type CandleTf, type HolderRiskDTO, type LiveEvent, type PlatformStatsDTO, type StatsDTO } from "@backflow/core";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import { parse as parseQuery } from "node:querystring";
import type { WebSocket } from "ws";
import { registerAuth, type AuthDeps } from "./auth";
import { cached, keyedCache } from "./cache";
import { ipKey, makeReporterId } from "./net";
import type { DataProvider } from "./provider";
import { registerActions, type ActionDeps } from "./routes/actions";
import { registerExtras, type ExtrasDeps } from "./routes/extras";

const TABS: readonly BoardTab[] = ["trending", "new", "near", "raydium"];
const TFS: readonly CandleTf[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export interface AppOptions {
  provider: DataProvider;
  logger?: boolean;
  corsOrigins?: string[] | false;
  rateLimitPerMinute?: number;
  /** Proxies whose X-Forwarded-For is trusted (TRUST_PROXY). Default "127.0.0.1": Nginx on the same host. */
  trustProxy?: string | number | boolean;
  /** Signed-nonce auth (POST /auth/nonce). Live mode. */
  auth?: AuthDeps;
  /** Live mode: routes that build transactions and upload metadata. */
  actions?: ActionDeps;
  /** Status, Telegram alerts, Helius wake-up. */
  extras?: ExtrasDeps;
  /** WebSocket caps (audit M3). */
  ws?: { maxConnections?: number; maxPerIp?: number; pingMs?: number };
}

function notFound(reply: FastifyReply, what: string) {
  return reply.code(404).send({ error: "not_found", message: `${what} isn't on Backflow.` });
}

function limitOf(v: unknown, def: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

/** Query strings: a repeated key keeps its first value, so handlers always get strings, never arrays (audit L2). */
export function parseQueryString(s: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(parseQuery(s, "&", "=", { maxKeys: 32 }))) out[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  return out;
}

const SERVER_ERROR = "Something went wrong on our side. Try again in a minute.";

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { provider } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: (opts.trustProxy ?? "127.0.0.1") as string,
    bodyLimit: 64 * 1024,
    routerOptions: { querystringParser: parseQueryString, maxParamLength: 200 },
  });

  // Log the details, answer 5xx with a generic message (audit L2). Validation errors get plain copy.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    if (err.validation) return reply.code(400).send({ error: "bad_request", message: "Some fields are missing, too long or the wrong type." });
    if (status >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(500).send({ error: "server_error", message: SERVER_ERROR });
    }
    if (status === 429) return reply.code(429).send({ error: "rate_limited", message: "Too many requests. Try again in a minute." });
    return reply.code(status).send({ error: "bad_request", message: err.message });
  });

  // Default is closed: only origins listed in CORS_ORIGINS may call the API from a browser.
  await app.register(cors, { origin: opts.corsOrigins ?? false, allowedHeaders: ["content-type", "accept", "authorization", "x-launch-token"] });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, {
    max: opts.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health",
    // req.ip is the real client (trustProxy + Nginx overwriting X-Forwarded-For); IPv6 grouped by /64
    keyGenerator: (req) => ipKey(req.ip),
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  const chain = opts.extras?.chain ?? null;
  app.get("/health", async () => ({
    ok: true,
    status: provider.mode === "live" && chain && chain.lookupTable() !== "ok" ? "degraded" : "ok",
    mode: provider.mode,
    time: new Date().toISOString(),
  }));

  // Small caches for public reads (audit L6). The stats cache also serves the WebSocket hello (M3).
  const statsC = cached<StatsDTO>(3_000);
  const platformC = cached<PlatformStatsDTO>(15_000);
  const riskC = keyedCache<string, HolderRiskDTO | null>(15_000, 1_000);

  app.get<{ Querystring: { tab?: string; q?: string; mints?: string } }>("/coins", async (req) => {
    const tab = (TABS as readonly string[]).includes(req.query.tab ?? "") ? (req.query.tab as BoardTab) : "trending";
    const q = String(req.query.q ?? "").slice(0, 64);
    const mints = req.query.mints ? String(req.query.mints).slice(0, 50 * 45).split(",").filter(looksLikeAddress).slice(0, 50) : undefined;
    return { tab, coins: await provider.listCoins(tab, q, mints) };
  });

  app.get<{ Params: { mint: string } }>("/coins/:mint/risk", async (req, reply) => {
    if (!looksLikeAddress(req.params.mint)) return notFound(reply, "This coin");
    const r = await riskC(req.params.mint, () => provider.holderRisk(req.params.mint));
    return r ?? notFound(reply, "This coin");
  });

  // Reports: the reporter is an anonymous per-day hash of the client address; any `wallet` field is ignored
  // because it isn't signed. One report per reporter per coin (audit L9).
  const reporterId = makeReporterId();
  app.post<{ Params: { mint: string }; Body: { reason?: string } }>(
    "/coins/:mint/report",
    { schema: { body: { type: "object", properties: { reason: { type: "string", maxLength: 1000 } } } }, config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (req, reply) => {
      if (!looksLikeAddress(req.params.mint)) return notFound(reply, "This coin");
      const reason = String(req.body?.reason ?? "").trim().slice(0, 200);
      if (reason.length < 3) return reply.code(400).send({ error: "bad_request", message: "Tell us what's wrong, in a few words." });
      const ok = await provider.report(req.params.mint, reason, reporterId(req.ip));
      return ok ? { ok: true } : notFound(reply, "This coin");
    },
  );

  app.get<{ Params: { address: string } }>("/wallet/:address/profile", async (req, reply) => {
    if (!looksLikeAddress(req.params.address)) return reply.code(400).send({ error: "bad_address", message: "That isn't a Solana wallet address." });
    return provider.profile(req.params.address);
  });

  app.get<{ Params: { mint: string } }>("/coins/:mint", async (req, reply) => {
    if (!looksLikeAddress(req.params.mint)) return notFound(reply, "This coin");
    const coin = await provider.getCoin(req.params.mint);
    return coin ?? notFound(reply, "This coin");
  });

  app.get<{ Params: { mint: string }; Querystring: { tf?: string } }>("/coins/:mint/candles", async (req, reply) => {
    if (!looksLikeAddress(req.params.mint)) return notFound(reply, "This coin");
    const tf = (TFS as readonly string[]).includes(req.query.tf ?? "") ? (req.query.tf as CandleTf) : "1m";
    const candles = await provider.candles(req.params.mint, tf);
    return candles ? { tf, candles } : notFound(reply, "This coin");
  });

  app.get<{ Params: { mint: string }; Querystring: { limit?: string } }>("/coins/:mint/trades", async (req, reply) => {
    if (!looksLikeAddress(req.params.mint)) return notFound(reply, "This coin");
    const trades = await provider.trades(req.params.mint, limitOf(req.query.limit, 30, 200));
    return trades ? { trades } : notFound(reply, "This coin");
  });

  app.get<{ Params: { mint: string }; Querystring: { limit?: string } }>("/coins/:mint/buybacks", async (req, reply) => {
    if (!looksLikeAddress(req.params.mint)) return notFound(reply, "This coin");
    const buybacks = await provider.coinBuybacks(req.params.mint, limitOf(req.query.limit, 30, 200));
    return buybacks ? { buybacks } : notFound(reply, "This coin");
  });

  app.get<{ Params: { mint: string } }>("/coins/:mint/holders", async (req, reply) => {
    if (!looksLikeAddress(req.params.mint)) return notFound(reply, "This coin");
    const holders = await provider.holders(req.params.mint);
    return holders ? { holders } : notFound(reply, "This coin");
  });

  app.get<{ Querystring: { limit?: string } }>("/buybacks", async (req) => ({
    buybacks: await provider.buybacks(limitOf(req.query.limit, 20, 200)),
  }));

  app.get("/stats", async () => statsC(() => provider.stats()));
  app.get("/stats/platform", async () => platformC(() => provider.platformStats()));

  app.get<{ Params: { id: string } }>("/buybacks/:id", async (req, reply) => {
    const b = await provider.buybackDetail(req.params.id.slice(0, 64));
    return b ?? notFound(reply, "This buyback");
  });

  /** The full credit list of one distribution, so anyone can re-check the TWAB split (CSV or JSON). */
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/buybacks/:id/credits", async (req, reply) => {
    const rows = await provider.buybackCredits(req.params.id.slice(0, 64));
    if (!rows) return notFound(reply, "This buyback");
    if (req.query.format === "csv") {
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="buyback-${req.params.id.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, "")}.csv"`);
      return "wallet,weight,amount\n" + rows.map((r) => `${r.wallet},${r.weight},${r.amount}`).join("\n") + "\n";
    }
    return { credits: rows };
  });

  app.get<{ Params: { address: string } }>("/wallet/:address/rewards", async (req, reply) => {
    if (!looksLikeAddress(req.params.address)) {
      return reply.code(400).send({ error: "bad_address", message: "That isn't a Solana wallet address." });
    }
    return provider.walletRewards(req.params.address);
  });

  app.get<{ Params: { address: string }; Querystring: { limit?: string } }>("/wallet/:address/history", async (req, reply) => {
    if (!looksLikeAddress(req.params.address)) {
      return reply.code(400).send({ error: "bad_address", message: "That isn't a Solana wallet address." });
    }
    return { items: await provider.walletHistory(req.params.address, limitOf(req.query.limit, 50, 200)) };
  });

  app.get<{ Params: { ticker: string } }>("/tickers/:ticker/available", async (req) => provider.tickerAvailable(req.params.ticker.slice(0, 32)));

  const notLive = async (_req: unknown, reply: FastifyReply) => reply.code(501).send({ error: "not_live", message: "This server runs with simulated data, so nothing can be sent on chain." });
  if (opts.auth) await registerAuth(app, opts.auth);
  else app.post("/auth/nonce", notLive);
  if (opts.actions) await registerActions(app, opts.actions);
  else {
    app.post("/launch/session", notLive);
    app.post("/launch/metadata", notLive);
    app.post("/launch/tx", notLive);
    app.post("/trade/tx", notLive);
    app.post("/creator/claim-tx", notLive);
    app.get("/coins/:mint/quote", notLive);
  }
  await registerExtras(app, opts.extras ?? { db: null, chain: null, publish: null, mode: provider.mode, platformConfig: null });

  /* ------------------------------- WebSocket ------------------------------- */
  // Caps in total and per client (Nginx adds limit_conn too); each event is serialized once for all
  // sockets; sockets that miss two pongs are terminated (audit M3).
  const wsMax = opts.ws?.maxConnections ?? 2_000;
  const wsPerIp = opts.ws?.maxPerIp ?? 20;
  const pingMs = opts.ws?.pingMs ?? 25_000;
  const sockets = new Set<WebSocket>();
  const perIp = new Map<string, number>();
  const offLive = provider.subscribe((e: LiveEvent) => {
    if (!sockets.size) return;
    const msg = JSON.stringify(e);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(msg);
  });

  app.get("/live", { websocket: true }, (socket, req) => {
    const key = ipKey(req.ip);
    const mine = perIp.get(key) ?? 0;
    if (sockets.size >= wsMax || mine >= wsPerIp) {
      socket.close(1013, "Too many connections. Try again later.");
      return;
    }
    perIp.set(key, mine + 1);
    sockets.add(socket);
    let missed = 0;
    socket.on("pong", () => {
      missed = 0;
    });
    const ping = setInterval(() => {
      if (missed >= 2) {
        socket.terminate();
        return;
      }
      missed++;
      if (socket.readyState === socket.OPEN) socket.ping();
    }, pingMs);
    socket.on("close", () => {
      clearInterval(ping);
      sockets.delete(socket);
      const left = (perIp.get(key) ?? 1) - 1;
      if (left > 0) perIp.set(key, left);
      else perIp.delete(key);
    });
    // Clients do not send anything yet; ignore input.
    socket.on("message", () => {});
    statsC(() => provider.stats())
      .then((stats) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "hello", stats } satisfies LiveEvent));
      })
      .catch((err: unknown) => req.log.warn({ err }, "hello stats failed"));
  });

  app.addHook("onClose", async () => {
    offLive();
    for (const s of sockets) s.terminate();
    chain?.close();
    await provider.close();
  });

  return app;
}
