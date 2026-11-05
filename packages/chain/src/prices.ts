/**
 * SOL/USD price (SPEC §6.1). Pyth Hermes by default, Jupiter as fallback.
 * Display and threshold use only; never feeds money math.
 */

const PYTH_SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export type PriceSource = "pyth" | "jupiter";

/**
 * Jupiter's keyed gateway (api.jup.ag, `x-api-key`) when JUPITER_API_KEY is set (free key from portal.jup.ag),
 * else the keyless lite-api, which Jupiter is rate-limiting down and phasing out. Paths are the same on both.
 */
export function jupiterGateway(env: NodeJS.ProcessEnv = process.env): { base: string; headers: Record<string, string> } {
  const key = env.JUPITER_API_KEY?.trim();
  return key ? { base: "https://api.jup.ag", headers: { "x-api-key": key } } : { base: "https://lite-api.jup.ag", headers: {} };
}

async function fetchJson(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: "application/json", ...headers } });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function pythSolUsd(timeoutMs = 5000): Promise<number> {
  const j = (await fetchJson(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SOL_USD}`, timeoutMs)) as {
    parsed?: { price: { price: string; expo: number } }[];
  };
  const p = j.parsed?.[0]?.price;
  if (!p) throw new Error("pyth: no price");
  const v = Number(p.price) * 10 ** p.expo;
  if (!(v > 0)) throw new Error("pyth: bad price");
  return v;
}

export async function jupiterSolUsd(timeoutMs = 5000): Promise<number> {
  const jup = jupiterGateway();
  const j = (await fetchJson(`${jup.base}/price/v3?ids=${SOL_MINT}`, timeoutMs, jup.headers)) as Record<string, { usdPrice?: number }>;
  const v = j[SOL_MINT]?.usdPrice;
  if (!v || !(v > 0)) throw new Error("jupiter: no price");
  return v;
}

/** Try the configured source, then the other one. */
export async function solUsd(primary: PriceSource = "pyth"): Promise<number> {
  const order = primary === "pyth" ? [pythSolUsd, jupiterSolUsd] : [jupiterSolUsd, pythSolUsd];
  let last: unknown;
  for (const f of order) {
    try {
      return await f();
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("no SOL/USD price");
}
