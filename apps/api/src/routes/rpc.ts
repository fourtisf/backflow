/**
 * POST /rpc: the site's Solana RPC (DECISIONS.md D-047). The browser sends JSON-RPC here and the API forwards it
 * to the server's RPC_URL, so the Helius key never reaches the page and the owner needs no second key or URL.
 *
 * Only the methods a wallet page needs are forwarded. Heavy or scanning methods (getProgramAccounts, history,
 * blocks) are refused, so this can't be used as a free general-purpose RPC on our key. Requests are already
 * rate-limited per client by Nginx and the API.
 */
import type { FastifyInstance } from "fastify";

export const RPC_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);
const MAX_BATCH = 10;

export interface RpcProxyDeps {
  /** Upstream RPC (the server's RPC_URL, with its key). */
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Call = { jsonrpc?: unknown; id?: unknown; method?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function registerRpcProxy(app: FastifyInstance, deps: RpcProxyDeps): Promise<void> {
  const f = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  app.post("/rpc", async (req, reply) => {
    const body = req.body as Call | Call[] | undefined;
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > MAX_BATCH) return reply.code(400).send(rpcError(null, -32600, `Send 1 to ${MAX_BATCH} requests at a time.`));
    for (const c of calls) {
      if (!c || typeof c !== "object" || c.jsonrpc !== "2.0" || typeof c.method !== "string") return reply.code(400).send(rpcError(c?.id, -32600, "Invalid JSON-RPC request."));
      if (!RPC_METHODS.has(c.method)) return reply.code(403).send(rpcError(c.id, -32601, `${c.method} is not available on this RPC.`));
    }
    let r: Response;
    try {
      r = await f(deps.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, "rpc proxy: upstream unreachable");
      return reply.code(502).send(rpcError(calls.length === 1 ? calls[0]!.id : null, -32603, "The Solana RPC is not reachable right now."));
    }
    const text = await r.text();
    return reply.code(r.status).header("content-type", "application/json").header("cache-control", "no-store").send(text);
  });
}
