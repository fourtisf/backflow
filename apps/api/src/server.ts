import { looksLikeAddress, parseCluster } from "@backflow/core";
import { getPrisma } from "@backflow/db";
import { buildApp, type AppOptions } from "./app";
import type { AuthDeps } from "./auth";
import { LiveProvider } from "./live/provider";
import { MockProvider } from "./mock/provider";
import { parseTrustProxy } from "./net";
import { OnChain } from "./onchain";

const port = Number(process.env.API_PORT ?? 4000);
// Loopback by default: Nginx is the only way in (audit L5).
const host = process.env.API_HOST || "127.0.0.1";
const mode = process.env.DATA_MODE ?? "mock";
const set = (v: string | undefined) => (v && !v.startsWith("REPLACE") ? v : "");

// One rejected promise somewhere must not take the API down (audit M3): log it and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: 50, time: Date.now(), msg: "unhandled promise rejection", err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason) }));
});

/**
 * Hot-wallet public keys for labels and exclusions (audit M6). The API reads *_PUBKEY values and never
 * loads the secret keys. Outside production only, it falls back to reading the keypair file, with a warning.
 */
async function walletPubkey(pubkeyEnv: string, keypairEnv: string, warn: (msg: string) => void): Promise<string> {
  const v = set(process.env[pubkeyEnv]);
  if (v) {
    if (looksLikeAddress(v)) return v;
    warn(`${pubkeyEnv} is not a valid address; ignoring it.`);
    return "";
  }
  if (process.env.NODE_ENV === "production") {
    warn(`${pubkeyEnv} is not set. Set it to the wallet's public key; the API does not read keypair files in production.`);
    return "";
  }
  if (!set(process.env[keypairEnv])) return "";
  try {
    const { loadKeypair } = await import("@backflow/chain");
    const pk = loadKeypair(keypairEnv).publicKey.toBase58();
    warn(`${pubkeyEnv} is not set; read it from ${keypairEnv} instead (development only). Set ${pubkeyEnv}=${pk}.`);
    return pk;
  } catch {
    return "";
  }
}

function authDomain(): string {
  const explicit = set(process.env.AUTH_DOMAIN);
  if (explicit) return explicit;
  try {
    return new URL(process.env.PUBLIC_SITE_URL || "http://localhost:3000").host;
  } catch {
    return "localhost:3000";
  }
}

async function options(warn: (msg: string) => void, log: { warn(o: object, msg: string): void; info(o: object, msg: string): void }): Promise<AppOptions> {
  const origins = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
  const base = { logger: true, corsOrigins: origins && origins.length ? origins : false, trustProxy: parseTrustProxy(process.env.TRUST_PROXY) } as const;
  if (mode === "mock") return { ...base, provider: new MockProvider() };
  if (mode !== "live") throw new Error(`DATA_MODE must be mock or live, got ${mode}`);

  const platform = set(process.env.PLATFORM_CONFIG_PUBKEY);
  if (!platform) throw new Error("DATA_MODE=live needs PLATFORM_CONFIG_PUBKEY (run pnpm platform:create first).");
  const db = getPrisma();
  const chain = new OnChain(platform, process.env.SOL_USD_SOURCE === "jupiter" ? "jupiter" : "pyth", Number(process.env.PRIORITY_FEE_MICROLAMPORTS ?? 20_000), log);
  if (!set(process.env.BACKFLOW_ALT)) warn("BACKFLOW_ALT is not set: launch transactions may exceed the size limit, and /health reports degraded. Run pnpm alt:create.");
  const wallets = {
    buyback: await walletPubkey("BUYBACK_PUBKEY", "BUYBACK_WALLET_KEYPAIR_PATH", warn),
    distributor: await walletPubkey("DISTRIBUTOR_PUBKEY", "DISTRIBUTOR_WALLET_KEYPAIR_PATH", warn),
    claim: await walletPubkey("PLATFORM_FEE_PUBKEY", "PLATFORM_FEE_WALLET_KEYPAIR_PATH", warn),
    treasury: set(process.env.TREASURY_PUBKEY),
  };
  let sub = null;
  let pub: { publish(ch: string, msg: string): Promise<unknown> } | null = null;
  if (process.env.REDIS_URL) {
    const { default: Redis } = await import("ioredis");
    sub = new Redis(process.env.REDIS_URL);
    pub = new Redis(process.env.REDIS_URL);
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
  const auth: AuthDeps = { db, domain: authDomain(), cluster: parseCluster(process.env.SOLANA_CLUSTER) };
  const jwt = set(process.env.PINATA_JWT);
  return {
    ...base,
    provider,
    auth,
    actions: { db, chain, auth, pinata: jwt ? { jwt, gateway: process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud/ipfs/" } : null, siteUrl: process.env.PUBLIC_SITE_URL || "" },
    extras: { db, chain, auth, publish: pub ? (ch, msg) => pub!.publish(ch, msg) : null, mode: "live", platformConfig: platform },
    ws: { maxConnections: Number(process.env.WS_MAX_CONNECTIONS) || undefined, maxPerIp: Number(process.env.WS_MAX_PER_IP) || undefined },
  };
}

const warnings: string[] = [];
const bootLog = {
  warn: (o: object, msg: string): void => {
    warnings.push(`${msg} ${JSON.stringify(o)}`);
  },
  info: (_o: object, _msg: string): void => {},
};
const app = await buildApp(
  await options((m) => {
    warnings.push(m);
  }, bootLog),
);
for (const w of warnings) app.log.warn(w);
// Lookup-table retries that happen after boot go straight to the app log.
bootLog.warn = (o, msg) => app.log.warn(o, msg);
bootLog.info = (o, msg) => app.log.info(o, msg);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port, host });
app.log.info(`api listening on ${host}:${port} (data mode: ${mode})`);
