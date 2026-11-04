import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp, parseQueryString } from "../src/app";
import { cached } from "../src/cache";
import { MockProvider } from "../src/mock/provider";
import { ipKey, makeReporterId, parseTrustProxy } from "../src/net";
import { tradeErrorMessage } from "../src/routes/actions";
import { same } from "../src/routes/extras";

describe("client identity (H2)", () => {
  it("groups IPv6 by /64 and unwraps IPv4-mapped addresses", () => {
    expect(ipKey("1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey(undefined)).toBe("unknown");
  });

  it("never trusts every proxy", () => {
    expect(parseTrustProxy(undefined)).toBe("127.0.0.1");
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("10.0.0.1,127.0.0.1")).toBe("10.0.0.1,127.0.0.1");
    expect(() => parseTrustProxy("true")).toThrow(/TRUST_PROXY/);
  });

  it("can't be given a fresh rate-limit bucket with a spoofed X-Forwarded-For", async () => {
    const app = await buildApp({ provider: new MockProvider({ tickMs: 0 }), rateLimitPerMinute: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      // what Nginx would forward if it appended: "<client's fake>, <real address>"
      const r = await app.inject({ method: "GET", url: "/buybacks", headers: { "x-forwarded-for": `10.0.${i}.${i}, 203.0.113.7` } });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    // plain copy, not the plugin's default text
    const r = await app.inject({ method: "GET", url: "/buybacks", headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(r.json().message).toBe("Too many requests. Try again in a minute.");
    await app.close();
  });

  it("gives each day a new anonymous reporter id", () => {
    const id = makeReporterId();
    const a = id("1.2.3.4", new Date("2026-11-04T10:00:00Z"));
    expect(id("1.2.3.4", new Date("2026-11-04T23:00:00Z"))).toBe(a);
    expect(id("1.2.3.5", new Date("2026-11-04T23:00:00Z"))).not.toBe(a);
    expect(id("1.2.3.4", new Date("2026-11-05T00:00:01Z"))).not.toBe(a);
    expect(a).not.toContain("1.2.3.4");
  });
});

describe("input handling (L2)", () => {
  it("keeps the first value of a repeated query key", () => {
    expect(parseQueryString("q=a&q=b&tab=new")).toEqual({ q: "a", tab: "new" });
  });

  it("answers repeated query keys with 200, not a leaked TypeError", async () => {
    const app = await buildApp({ provider: new MockProvider({ tickMs: 0 }) });
    expect((await app.inject({ method: "GET", url: "/coins?q=a&q=b" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/coins?mints=a&mints=b" })).statusCode).toBe(200);
    await app.close();
  });

  it("hides internal error messages on 5xx and validates bodies", async () => {
    const app = await buildApp({ provider: new MockProvider({ tickMs: 0 }) });
    app.get("/boom", async () => {
      throw new Error("db password is hunter2");
    });
    const r = await app.inject({ method: "GET", url: "/boom" });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("hunter2");
    const mint = (await app.inject({ method: "GET", url: "/coins" })).json().coins[0].mint as string;
    const bad = await app.inject({ method: "POST", url: `/coins/${mint}/report`, payload: { reason: { nested: true } } });
    expect(bad.statusCode).toBe(400);
    const long = await app.inject({ method: "POST", url: `/coins/${mint}/report`, payload: { reason: "x".repeat(5000) } });
    expect(long.statusCode).toBe(400);
    await app.close();
  });

  it("maps chain and builder errors to fixed messages", () => {
    expect(tradeErrorMessage(new Error("failed to get recent blockhash: FetchError: request to https://rpc?api-key=SECRET"))).toBe("Couldn't build the transaction. Try again in a minute.");
    expect(tradeErrorMessage(new Error("pool not found"))).toMatch(/pool couldn't be read/);
    expect(tradeErrorMessage(new Error("transaction is 1300 bytes, over the 1232-byte limit"))).toMatch(/too large/);
  });

  it("compares secrets of different byte lengths without throwing", () => {
    expect(same("abc", "abc")).toBe(true);
    expect(same("abc", "abd")).toBe(false);
    expect(same("é", "ab")).toBe(false);
    expect(same("", "x")).toBe(false);
  });

  it("validates coin addresses in paths", async () => {
    const app = await buildApp({ provider: new MockProvider({ tickMs: 0 }) });
    expect((await app.inject({ method: "GET", url: "/coins/..%2Fstats" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("caches", () => {
  it("merges concurrent loads and doesn't cache failures", async () => {
    const c = cached<number>(1000);
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 7;
    };
    expect(await Promise.all([c(load), c(load), c(load)])).toEqual([7, 7, 7]);
    expect(calls).toBe(1);
    const f = cached<number>(1000);
    await expect(f(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await f(async () => 1)).toBe(1);
  });
});

describe("WebSocket /live (M3)", () => {
  it("caps connections per client and sends the hello from the stats cache", async () => {
    const provider = new MockProvider({ tickMs: 0 });
    let statsCalls = 0;
    const orig = provider.stats.bind(provider);
    provider.stats = async () => {
      statsCalls++;
      return orig();
    };
    const app = await buildApp({ provider, ws: { maxPerIp: 2 } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const open = () =>
      new Promise<{ ws: WebSocket; first: Promise<string>; closed: Promise<number> }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
        const first = new Promise<string>((r) => ws.once("message", (m) => r(String(m))));
        const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
        ws.once("open", () => resolve({ ws, first, closed }));
        ws.once("error", reject);
      });
    const a = await open();
    const b = await open();
    expect(JSON.parse(await a.first).type).toBe("hello");
    expect(JSON.parse(await b.first).type).toBe("hello");
    expect(statsCalls).toBe(1);
    const c = await open();
    expect(await c.closed).toBe(1013);
    a.ws.close();
    b.ws.close();
    await app.close();
  });
});
