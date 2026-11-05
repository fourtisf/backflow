import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { MockProvider } from "../src/mock/provider";

const UP = "https://mainnet.helius-rpc.com/?api-key=SERVER_KEY";

async function appWith(fetchImpl?: typeof fetch) {
  return buildApp({ provider: new MockProvider({ tickMs: 0 }), rpcProxy: fetchImpl ? { url: UP, fetch: fetchImpl } : undefined });
}

describe("POST /rpc (D-047)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards allowed calls to the server's RPC and returns its answer", async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 9 }, value: 42 } }), { status: 200 }));
    const app = await appWith(f as unknown as typeof fetch);
    const res = await app.inject({ method: "POST", url: "/rpc", payload: { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["11111111111111111111111111111111"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.value).toBe(42);
    expect(f).toHaveBeenCalledOnce();
    expect(String(f.mock.calls[0]![0])).toBe(UP);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body)).method).toBe("getBalance");
    expect(res.body).not.toContain("SERVER_KEY");
  });

  it("refuses methods a wallet page doesn't need, without calling upstream", async () => {
    const f = vi.fn();
    const app = await appWith(f as unknown as typeof fetch);
    for (const method of ["getProgramAccounts", "getSignaturesForAddress", "getBlock", "requestAirdrop"]) {
      const res = await app.inject({ method: "POST", url: "/rpc", payload: { jsonrpc: "2.0", id: 7, method, params: [] } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe(-32601);
    }
    // one bad call poisons the batch
    const res = await app.inject({ method: "POST", url: "/rpc", payload: [{ jsonrpc: "2.0", id: 1, method: "getSlot" }, { jsonrpc: "2.0", id: 2, method: "getProgramAccounts" }] });
    expect(res.statusCode).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized batches", async () => {
    const app = await appWith(vi.fn() as unknown as typeof fetch);
    expect((await app.inject({ method: "POST", url: "/rpc", payload: { id: 1, method: "getSlot" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/rpc", payload: [] })).statusCode).toBe(400);
    const big = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getSlot" }));
    expect((await app.inject({ method: "POST", url: "/rpc", payload: big })).statusCode).toBe(400);
  });

  it("answers 502 when the upstream is down", async () => {
    const app = await appWith((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    const res = await app.inject({ method: "POST", url: "/rpc", payload: { jsonrpc: "2.0", id: 3, method: "getHealth" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().id).toBe(3);
  });

  it("is closed in mock mode", async () => {
    const app = await appWith();
    expect((await app.inject({ method: "POST", url: "/rpc", payload: { jsonrpc: "2.0", id: 1, method: "getSlot" } })).statusCode).toBe(501);
  });
});
