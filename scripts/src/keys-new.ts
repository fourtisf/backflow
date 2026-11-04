/**
 * Generate the hot-wallet keypairs into a directory OUTSIDE the repo.
 *
 *   pnpm --filter @backflow/scripts keys:new -- --dir ~/.config/backflow/keys
 *
 * Never overwrites an existing file. Prints public keys only.
 */
import { Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, arg } from "./lib/env";

const NAMES = ["platform-admin", "platform-fee", "buyback", "distributor"];

const dir = resolve((arg("dir") ?? join(homedir(), ".config/backflow/keys")).replace(/^~(?=$|\/)/, homedir()));
if (dir === REPO_ROOT || dir.startsWith(REPO_ROOT + "/")) {
  console.error(`Refusing to write keys inside the repo (${dir}).`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const n of NAMES) {
  const p = join(dir, `${n}.json`);
  if (existsSync(p)) {
    console.log(`${n.padEnd(15)} exists, skipped  ${p}`);
    continue;
  }
  const k = Keypair.generate();
  writeFileSync(p, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  console.log(`${n.padEnd(15)} ${k.publicKey.toBase58()}  ${p}`);
}
console.log(`\nSet the *_KEYPAIR_PATH variables in .env to these files.`);
