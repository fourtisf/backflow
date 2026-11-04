/**
 * Shared helpers for operator scripts: cluster guard, RPC, keypair loading.
 *
 * Hard rule (CLAUDE.md #2): no mainnet transactions without the owner's
 * explicit approval. Scripts refuse mainnet unless BACKFLOW_MAINNET_APPROVED
 * is set to the exact phrase below, which the owner sets by hand.
 */
import { RAYDIUM, parseCluster, type Cluster } from "@backflow/core";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");  // packages/chain/src -> repo root
const MAINNET_PHRASE = "owner-approved-mainnet";

/**
 * The configured cluster. Scripts that send transactions call cluster(); read-only
 * scripts call cluster({ readOnly: true }), which may read mainnet without approval.
 */
export function cluster(opts: { readOnly?: boolean } = {}): Cluster {
  const c = parseCluster(process.env.SOLANA_CLUSTER);
  if (c === "mainnet-beta" && !opts.readOnly && process.env.BACKFLOW_MAINNET_APPROVED !== MAINNET_PHRASE) {
    throw new Error(
      "Refusing to touch mainnet. Mainnet needs explicit approval from the owner (CLAUDE.md rule 2). " +
        `If the owner approved it, set BACKFLOW_MAINNET_APPROVED=${MAINNET_PHRASE} for this one command.`,
    );
  }
  return c;
}

export function addresses(c: Cluster = cluster()) {
  const a = RAYDIUM[c];
  return {
    launchLabProgram: new PublicKey(a.launchLabProgram),
    globalConfig: new PublicKey(process.env.GLOBAL_CONFIG_PUBKEY && !process.env.GLOBAL_CONFIG_PUBKEY.startsWith("REPLACE") ? process.env.GLOBAL_CONFIG_PUBKEY : a.globalConfigWsolCp),
    cpmmProgram: new PublicKey(a.cpmmProgram),
    lockProgram: new PublicKey(a.lockProgram),
  };
}

export function rpcUrl(c: Cluster = cluster()): string {
  const u = process.env.RPC_URL;
  if (u && !u.includes("REPLACE")) return u;
  return clusterApiUrl(c);
}

export function connection(c: Cluster = cluster()): Connection {
  return new Connection(rpcUrl(c), "confirmed");
}

/** Load a keypair JSON (array of 64 numbers). Refuses files inside the repo. */
export function loadKeypair(envName: string): Keypair {
  const p = process.env[envName];
  if (!p) throw new Error(`${envName} is not set. Point it at a keypair JSON file outside the repo.`);
  const abs = resolve(p);
  if (abs.startsWith(REPO_ROOT + "/") || abs === REPO_ROOT) {
    throw new Error(`${envName} points inside the repo (${abs}). Keep keys outside the repo.`);
  }
  if (!existsSync(abs)) throw new Error(`${envName}: no file at ${abs}. Create one with: pnpm --filter @backflow/scripts keys:new`);
  const arr = JSON.parse(readFileSync(abs, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

/** Read a public key from an env var that holds either a pubkey or a keypair path. */
export function pubkeyFrom(envName: string, fallback?: PublicKey): PublicKey {
  const v = process.env[envName];
  if (!v || v.startsWith("REPLACE")) {
    if (fallback) return fallback;
    throw new Error(`${envName} is not set.`);
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return new PublicKey(v);
  return loadKeypair(envName).publicKey;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
