import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { looksLikeAddress, type BoardTab, type CandleTf, type LiveEvent } from "@backflow/core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { DataProvider } from "./provider";

const TABS: readonly BoardTab[] = ["trending", "new", "near", "raydium"];
const TFS: readonly CandleTf[] = ["1m", "5m", "15m"];

export interface AppOptions {
  provider: DataProvider;
  logger?: boolean;
  corsOrigins?: string[] | true;
  rateLimitPerMinute?: number;
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

  await app.register(cors, { origin: opts.corsOrigins ?? true });
  await app.register(rateLimit, {
    max: opts.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health",
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.get("/health", async () => ({ ok: true, mode: provider.mode, time: new Date().toISOString() }));

  app.get<{ Querystring: { tab?: string; q?: string } }>("/coins", async (req) => {
    const tab = (TABS as readonly string[]).includes(req.query.tab ?? "") ? (req.query.tab as BoardTab) : "trending";
    const q = (req.query.q ?? "").slice(0, 64);
    return { tab, coins: await provider.listCoins(tab, q) };
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

  app.get<{ Params: { address: string } }>("/wallet/:address/rewards", async (req, reply) => {
    if (!looksLikeAddress(req.params.address)) {
      return reply.code(400).send({ error: "bad_address", message: "That isn't a Solana wallet address." });
    }
    return provider.walletRewards(req.params.address);
  });

  app.get<{ Params: { ticker: string } }>("/tickers/:ticker/available", async (req) => provider.tickerAvailable(req.params.ticker));

  // Milestone 2 implements the IPFS upload. Kept here so the route table matches SPEC §6.2.
  app.post("/launch/metadata", async (_req, reply) =>
    reply.code(501).send({ error: "not_implemented", message: "Launching isn't live yet in this build." }),
  );

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
