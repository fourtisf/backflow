/**
 * Grind mint keypairs whose address ends in "buy" (case-sensitive, matching the Rebuy name; --suffix to change) and store them encrypted
 * (SPEC §4, optional; DECISIONS D-025). Run on the VPS, off the request path.
 *
 *   VANITY_KEY=<64 hex> pnpm vanity:grind -- --count 20 --threads 4 [--suffix back]
 *
 * Expect about 11M tries per key for a 4-character suffix; each thread does roughly 20–40k tries/s.
 */
import { arg, encryptSecret } from "@backflow/chain";
import { getPrisma } from "@backflow/db";
import bs58 from "bs58";
import { generateKeyPairSync } from "node:crypto";
import { availableParallelism } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

function grind(suffix: string): { pub: string; secret: Uint8Array } {
  for (;;) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubBytes = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
    const addr = bs58.encode(pubBytes);
    if (!addr.endsWith(suffix)) continue;
    const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
    return { pub: addr, secret: new Uint8Array(Buffer.concat([seed, pubBytes])) };
  }
}

async function main() {
  const count = Number(arg("count") ?? 10);
  const threads = Math.min(Number(arg("threads") ?? availableParallelism()), 32);
  const suffix = arg("suffix") ?? "buy";
  if (!/^[1-9A-HJ-NP-Za-km-z]{1,6}$/.test(suffix)) throw new Error("suffix must be base58, 1–6 characters");
  encryptSecret(new Uint8Array(64)); // fail fast if VANITY_KEY is missing or malformed
  const db = getPrisma();
  let found = 0;
  const workers: Worker[] = [];
  const started = Date.now();
  for (let i = 0; i < threads; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { suffix }, execArgv: ["--import", "tsx"] });
    w.on("message", async (m: { pub: string; secret: Uint8Array }) => {
      if (found >= count) return;
      found++;
      await db.vanityMint.create({ data: { pubkey: m.pub, secretEnc: encryptSecret(m.secret) } });
      console.log(`${found}/${count}  ${m.pub}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
      if (found >= count) {
        for (const x of workers) void x.terminate();
        await db.$disconnect();
      }
    });
    workers.push(w);
  }
}

if (isMainThread) {
  main().catch((e) => {
    console.error((e as Error).message ?? e);
    process.exit(1);
  });
} else {
  const { suffix } = workerData as { suffix: string };
  for (;;) parentPort!.postMessage(grind(suffix));
}
