/**
 * POST /rpc: the site's Solana RPC (DECISIONS.md D-047). The browser sends JSON-RPC here and the API forwards it
 * to the server's RPC_URL, so the Helius key never reaches the page and the owner needs no second key or URL.
 *
 * Only the five methods the site uses are forwarded, one call per request, 120 per minute per client and
 * GLOBAL_PER_SECOND for everyone together, with answers capped at 1 MB. So it can't be used as a free RPC on
 * our key, and visitors can't use up the plan the workers depend on (audit).
 */
import type { FastifyInstance } from "fastify";

/** Exactly what the site and the wallet adapters call (audit): balance, blockhash, send, status, health. */
export const RPC_METHODS: ReadonlySet<string> = new Set(["getBalance", "getHealth", "getLatestBlockhash", "getSignatureStatuses", "getTokenAccountsByOwner", "sendTransaction"]);
/** One call per request: every call is a billed Helius request, so batches would multiply the cost. */
const MAX_BATCH = 1;
/** Upstream answers above this are cut off (none of the methods above returns more). */
const MAX_RESPONSE_BYTES = 1_000_000;
/** All browsers together, per second, so visitors can't use up the plan the workers depend on. Reads
 *  (balances, health) and the transaction path (blockhash, send, status) have separate budgets, so balance
 *  polling can never block a user's trade from being sent or confirmed (audit). */
const GLOBAL_PER_SECOND = Number(process.env.RPC_PROXY_READS_PER_SECOND) || 25;
const TX_PER_SECOND = Number(process.env.RPC_PROXY_TX_PER_SECOND) || 60;
const TX_METHODS: ReadonlySet<string> = new Set(["getLatestBlockhash", "sendTransaction", "getSignatureStatuses"]);

export interface RpcProxyDeps {
  /** Upstream RPC (the server's RPC_URL, with its key). */
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Overrides for tests. */
  perMinutePerClient?: number;
  globalPerSecond?: number;
  txPerSecond?: number;
}

/** Reads at most `max` bytes of a response body; null if it is longer. */
async function readCapped(r: Response, max: number): Promise<string | null> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Call = { jsonrpc?: unknown; id?: unknown; method?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function registerRpcProxy(app: FastifyInstance, deps: RpcProxyDeps): Promise<void> {
  const f = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const budgets = { read: { max: deps.globalPerSecond ?? GLOBAL_PER_SECOND, start: 0, used: 0 }, tx: { max: deps.txPerSecond ?? TX_PER_SECOND, start: 0, used: 0 } };
  app.post("/rpc", { config: { rateLimit: { max: deps.perMinutePerClient ?? 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = req.body as Call | Call[] | undefined;
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > MAX_BATCH) return reply.code(400).send(rpcError(null, -32600, `Send 1 to ${MAX_BATCH} requests at a time.`));
    for (const c of calls) {
      if (!c || typeof c !== "object" || c.jsonrpc !== "2.0" || typeof c.method !== "string") return reply.code(400).send(rpcError(c?.id, -32600, "Invalid JSON-RPC request."));
      if (!RPC_METHODS.has(c.method)) return reply.code(403).send(rpcError(c.id, -32601, `${c.method} is not available on this RPC.`));
      // token accounts only for one mint (the sell panel's balance), never a whole program's (D-055)
      if (c.method === "getTokenAccountsByOwner") {
        const filter = (c as { params?: unknown[] }).params?.[1] as { mint?: unknown } | undefined;
        if (!filter || typeof filter.mint !== "string") return reply.code(403).send(rpcError(c.id, -32601, "getTokenAccountsByOwner needs a mint filter here."));
      }
    }
    const b = TX_METHODS.has(calls[0]!.method as string) ? budgets.tx : budgets.read;
    const now = Date.now();
    if (now - b.start >= 1000) {
      b.start = now;
      b.used = 0;
    }
    if (++b.used > b.max) return reply.code(429).send(rpcError(calls[0]!.id, -32005, "The RPC is busy. Try again in a moment."));
    let r: Response;
    try {
      r = await f(deps.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, "rpc proxy: upstream unreachable");
      return reply.code(502).send(rpcError(calls.length === 1 ? calls[0]!.id : null, -32603, "The Solana RPC is not reachable right now."));
    }
    const text = await readCapped(r, MAX_RESPONSE_BYTES).catch(() => null);
    if (text == null) return reply.code(502).send(rpcError(calls[0]!.id, -32603, "The Solana RPC answer was too large."));
    return reply.code(r.status).header("content-type", "application/json").header("cache-control", "no-store").send(text);
  });
}
