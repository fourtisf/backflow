import { getPrisma } from "@backflow/db";
import { buildApp, type AppOptions } from "./app";
import { LiveProvider } from "./live/provider";
import { MockProvider } from "./mock/provider";
import { OnChain } from "./onchain";

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";
const mode = process.env.DATA_MODE ?? "mock";
const set = (v: string | undefined) => (v && !v.startsWith("REPLACE") ? v : "");

async function pubkeyOf(envPath: string): Promise<string> {
  try {
    const { loadKeypair } = await import("@backflow/chain");
    return loadKeypair(envPath).publicKey.toBase58();
  } catch {
    return "";
  }
}

async function options(): Promise<AppOptions> {
  const origins = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
  const base = { logger: true, corsOrigins: origins && origins.length ? origins : false } as const;
  if (mode === "mock") return { ...base, provider: new MockProvider() };
  if (mode !== "live") throw new Error(`DATA_MODE must be mock or live, got ${mode}`);

  const platform = set(process.env.PLATFORM_CONFIG_PUBKEY);
  if (!platform) throw new Error("DATA_MODE=live needs PLATFORM_CONFIG_PUBKEY (run pnpm platform:create first).");
  const db = getPrisma();
  const chain = new OnChain(platform, process.env.SOL_USD_SOURCE === "jupiter" ? "jupiter" : "pyth", Number(process.env.PRIORITY_FEE_MICROLAMPORTS ?? 20_000));
  const wallets = {
    buyback: await pubkeyOf("BUYBACK_WALLET_KEYPAIR_PATH"),
    distributor: await pubkeyOf("DISTRIBUTOR_WALLET_KEYPAIR_PATH"),
    claim: await pubkeyOf("PLATFORM_FEE_WALLET_KEYPAIR_PATH"),
    treasury: set(process.env.TREASURY_PUBKEY),
  };
  let sub = null;
  if (process.env.REDIS_URL) {
    const { default: Redis } = await import("ioredis");
    sub = new Redis(process.env.REDIS_URL);
  }
  const provider = new LiveProvider({
    db,
    chain,
    sub,
    platformWallets: [
      { address: wallets.buyback, label: "Buyback wallet" },
      { address: wallets.distributor, label: "Distributor" },
      { address: wallets.claim, label: "Platform fee wallet" },
      { address: wallets.treasury, label: "Treasury" },
    ],
  });
  const jwt = set(process.env.PINATA_JWT);
  return {
    ...base,
    provider,
    actions: { db, chain, pinata: jwt ? { jwt, gateway: process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud/ipfs/" } : null, siteUrl: process.env.PUBLIC_SITE_URL || "" },
    admin: { db, chain, admins: new Set((process.env.ADMIN_WALLETS ?? "").split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("REPLACE"))), wallets, platformConfig: platform },
  };
}

const app = await buildApp(await options());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port, host });
app.log.info(`api listening on ${host}:${port} (data mode: ${mode})`);
