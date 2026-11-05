import { afterEach, describe, expect, it, vi } from "vitest";
import { jupiterGateway, jupiterSolUsd } from "../src/prices";

const SOL = "So11111111111111111111111111111111111111112";

describe("jupiter gateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the keyless lite-api without a key", () => {
    expect(jupiterGateway({})).toEqual({ base: "https://lite-api.jup.ag", headers: {} });
    expect(jupiterGateway({ JUPITER_API_KEY: "  " })).toEqual({ base: "https://lite-api.jup.ag", headers: {} });
  });

  it("uses api.jup.ag with x-api-key when a key is set", () => {
    expect(jupiterGateway({ JUPITER_API_KEY: "k1" })).toEqual({ base: "https://api.jup.ag", headers: { "x-api-key": "k1" } });
  });

  it("sends the key with the price request", async () => {
    vi.stubEnv("JUPITER_API_KEY", "k2");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ [SOL]: { usdPrice: 150.5 } })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(jupiterSolUsd()).resolves.toBe(150.5);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.jup.ag/price/v3?ids=${SOL}`);
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("k2");
  });
});
