import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { looksLikeAddress, type BoardTab, type CandleTf, type LiveEvent } from "@backflow/core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { DataProvider } from "./provider";
import { registerActions, type ActionDeps } from "./routes/actions";
import { registerAdmin, type AdminDeps } from "./routes/admin";
import { registerExtras, type ExtrasDeps } from "./routes/extras";

const TABS: readonly BoardTab[] = ["trending", "new", "near", "raydium"];
const TFS: readonly CandleTf[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export interface AppOptions {
  provider: DataProvider;
  logger?: boolean;
  corsOrigins?: string[] | false;
  rateLimitPerMinute?: number;
  /** Live mode: routes that build transactions and upload metadata. */
  actions?: ActionDeps;
  /** Live mode: admin routes. */
  admin?: AdminDeps;
  /** Status, Telegram alerts, Helius wake-up. */
  extras?: ExtrasDeps;
}

function notFound(reply: FastifyReply, what: string) {
  return reply.code(404).send({ error: "not_found", message: `${what} isn't on Backflow.` });
}

function limitOf(v: unknown, def: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { provider } = opts;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });

  // Default is closed: only origins listed in CORS_ORIGINS may call the API from a browser.
  await app.register(cors, { origin: opts.corsOrigins ?? false });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, {
    max: opts.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health",
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.get("/health", async () => ({ ok: true, mode: provider.mode, time: new Date().toISOString() }));

  app.get<{ Querystring: { tab?: string; q?: string; mints?: string } }>("/coins", async (req) => {
    const tab = (TABS as readonly string[]).includes(req.query.tab ?? "") ? (req.query.tab as BoardTab) : "trending";
    const q = (req.query.q ?? "").slice(0, 64);
    const mints = req.query.mints ? req.query.mints.split(",").filter(looksLikeAddress).slice(0, 50) : undefined;
    return { tab, coins: await provider.listCoins(tab, q, mints) };
  });

  app.get<{ Params: { mint: string } }>("/coins/:mint/risk", async (req, reply) => {
    const r = await provider.holderRisk(req.params.mint);
    return r ?? notFound(reply, "This coin");
  });

  app.post<{ Params: { mint: string }; Body: { reason?: string; wallet?: string } }>("/coins/:mint/report", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req, reply) => {
    const reason = String(req.body?.reason ?? "").trim().slice(0, 200);
    if (reason.length < 3) return reply.code(400).send({ error: "bad_request", message: "Tell us what's wrong, in a few words." });
    const reporter = req.body?.wallet && looksLikeAddress(req.body.wallet) ? req.body.wallet : `ip:${req.ip}`;
    const ok = await provider.report(req.params.mint, reason, reporter);
    return ok ? { ok: true } : notFound(reply, "This coin");
  });

  app.get<{ Params: { address: string } }>("/wallet/:address/profile", async (req, reply) => {
    if (!looksLikeAddress(req.params.address)) return reply.code(400).send({ error: "bad_address", message: "That isn't a Solana wallet address." });
    return provider.profile(req.params.address);
  });

  app.get<{ Params: { mint: string } }>("/coins/:mint", async (req, reply) => {
    const coin = await provider.getCoin(req.params.mint);
    return coin ?? notFound(reply, "This coin");
  });

  app.get<{ Params: { mint: string }; Querystring: { tf?: string } }>("/coins/:mint/candles", async (req, reply) => {
    const tf = (TFS as readonly string[]).includes(req.query.tf ?? "") ? (req.query.tf as CandleTf) : "1m";
    const candles = await provider.candles(req.params.mint, tf);
    return candles ? { tf, candles } : notFound(reply, "This coin");
  });

  app.get<{ Params: { mint: string }; Querystring: { limit?: string } }>("/coins/:mint/trades", async (req, reply) => {
    const trades = await provider.trades(req.params.mint, limitOf(req.query.limit, 30, 200));
    return trades ? { trades } : notFound(reply, "This coin");
  });

  app.get<{ Params: { mint: string }; Querystring: { limit?: string } }>("/coins/:mint/buybacks", async (req, reply) => {
    const buybacks = await provider.coinBuybacks(req.params.mint, limitOf(req.query.limit, 30, 200));
    return buybacks ? { buybacks } : notFound(reply, "This coin");
  });

  app.get<{ Params: { mint: string } }>("/coins/:mint/holders", async (req, reply) => {
    const holders = await provider.holders(req.params.mint);
    return holders ? { holders } : notFound(reply, "This coin");
  });

  app.get<{ Querystring: { limit?: string } }>("/buybacks", async (req) => ({
    buybacks: await provider.buybacks(limitOf(req.query.limit, 20, 200)),
  }));

  app.get("/stats", async () => provider.stats());
  app.get("/stats/platform", async () => provider.platformStats());

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

  app.get<{ Params: { ticker: string } }>("/tickers/:ticker/available", async (req) => provider.tickerAvailable(req.params.ticker));

  if (opts.actions) await registerActions(app, opts.actions);
  else {
    const notLive = async (_req: unknown, reply: FastifyReply) => reply.code(501).send({ error: "not_live", message: "This server runs with simulated data, so nothing can be sent on chain." });
    app.post("/launch/metadata", notLive);
    app.post("/launch/tx", notLive);
    app.post("/trade/tx", notLive);
    app.post("/creator/claim-tx", notLive);
    app.get("/coins/:mint/quote", notLive);
  }
  if (opts.admin) await registerAdmin(app, opts.admin);
  await registerExtras(app, opts.extras ?? { db: null, chain: null, publish: null, mode: provider.mode, platformConfig: null });

  app.get("/live", { websocket: true }, (socket) => {
    const send = (e: LiveEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    };
    void provider.stats().then((stats) => send({ type: "hello", stats }));
    const off = provider.subscribe(send);
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25_000);
    socket.on("close", () => {
      off();
      clearInterval(ping);
    });
    // Clients do not send anything yet; ignore input.
    socket.on("message", () => {});
  });

  app.addHook("onClose", async () => {
    await provider.close();
  });

  return app;
}
