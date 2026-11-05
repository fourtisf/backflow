/**
 * Top up the server's working wallets from the platform fee wallet, which is the one address the owner
 * sends SOL to (DECISIONS.md D-044).
 *
 *   pnpm wallets:fund            # dry run: balances and the transfers it would make
 *   pnpm wallets:fund --send     # sends them in one transaction
 *
 * Targets in SOL: --admin 0.02 --buyback 0.1 --distributor 0.05, and the fee wallet keeps at least --keep 0.03.
 * The admin wallet is only topped up while its key file is on this server (it pays for creating the platform).
 * Wallets already at or above their target get nothing. All amounts are bigint lamports.
 */
import { formatUnits, parseUnits } from "@backflow/core";
import { cluster, connection, flag, arg, loadKeypair, pubkeyFrom } from "@backflow/chain";
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { existsSync } from "node:fs";

export interface Want {
  name: string;
  balance: bigint;
  target: bigint;
}

/**
 * Transfers that bring each wallet up to its target, paid by the server wallet, which must still hold `keep`
 * afterwards. `needed` is how much SOL is missing for all of that (0 when there is enough).
 */
export function planTopUps(balance: bigint, keep: bigint, wants: Want[]): { transfers: { name: string; lamports: bigint }[]; needed: bigint } {
  const transfers = wants.filter((w) => w.balance < w.target).map((w) => ({ name: w.name, lamports: w.target - w.balance }));
  const total = transfers.reduce((s, t) => s + t.lamports, 0n);
  return { transfers, needed: total + keep > balance ? total + keep - balance : 0n };
}

const sol = (l: bigint) => formatUnits(l, 9);

function solArg(name: string, dflt: string): bigint {
  const v = parseUnits(arg(name) ?? dflt, 9);
  if (v == null || v < 0n) throw new Error(`--${name} must be an amount in SOL`);
  return v;
}

async function main() {
  const c = cluster();
  const conn = connection(c);
  const fee = loadKeypair("PLATFORM_FEE_WALLET_KEYPAIR_PATH");
  let keep = solArg("keep", "0.03");
  const created = !!process.env.PLATFORM_CONFIG_PUBKEY && !process.env.PLATFORM_CONFIG_PUBKEY.startsWith("REPLACE");
  const adminPath = process.env.PLATFORM_ADMIN_KEYPAIR_PATH;
  const admin = adminPath && existsSync(adminPath) ? pubkeyFrom("PLATFORM_ADMIN_KEYPAIR_PATH") : process.env.PLATFORM_ADMIN_PUBKEY ? new PublicKey(process.env.PLATFORM_ADMIN_PUBKEY) : null;
  const all: { name: string; key: PublicKey; target: bigint }[] = [
    // the admin only needs SOL to pay for creating the platform
    ...(admin && !created ? [{ name: "admin", key: admin, target: solArg("admin", "0.02") }] : []),
    { name: "buyback", key: new PublicKey(process.env.BUYBACK_PUBKEY ?? ""), target: solArg("buyback", "0.1") },
    { name: "distributor", key: new PublicKey(process.env.DISTRIBUTOR_PUBKEY ?? ""), target: solArg("distributor", "0.05") },
  ];
  // A role the server wallet holds itself (one server wallet, D-045) needs no transfer: it keeps that SOL.
  const own = all.filter((t) => t.key.equals(fee.publicKey));
  for (const t of own) keep += t.target;
  const targets = all.filter((t) => !t.key.equals(fee.publicKey));
  const feeBal = BigInt(await conn.getBalance(fee.publicKey, "confirmed"));
  const wants: Want[] = [];
  console.log(`cluster ${c}\n\nserver wallet  ${fee.publicKey.toBase58()}  ${sol(feeBal)} SOL  (keeps at least ${sol(keep)}${own.length ? ` for ${["fees", ...own.map((t) => t.name)].join(", ")}` : ""})`);
  for (const t of targets) {
    const balance = BigInt(await conn.getBalance(t.key, "confirmed"));
    wants.push({ name: t.name, balance, target: t.target });
    console.log(`${t.name.padEnd(30)} ${t.key.toBase58()}  ${sol(balance)} SOL  (target ${sol(t.target)})`);
  }
  const plan = planTopUps(feeBal, keep, wants);
  if (plan.transfers.length) {
    console.log("\nTransfers from the server wallet:");
    for (const t of plan.transfers) console.log(`  ${t.name.padEnd(12)} ${sol(t.lamports)} SOL`);
  }
  if (plan.needed > 0n) {
    console.log(`\nNot enough SOL. Send at least ${sol(plan.needed + 5_000_000n)} SOL more to ${fee.publicKey.toBase58()}, then run this again.`);
    process.exitCode = 5;
    return;
  }
  if (!plan.transfers.length) {
    console.log("\nEvery wallet is at its target. Nothing to send.");
    return;
  }
  if (!flag("send")) {
    console.log("\nDry run. Nothing was sent. Re-run with --send.");
    return;
  }
  const byName = new Map(targets.map((t) => [t.name, t.key]));
  const tx = new Transaction();
  for (const t of plan.transfers) tx.add(SystemProgram.transfer({ fromPubkey: fee.publicKey, toPubkey: byName.get(t.name)!, lamports: t.lamports }));
  const sig = await sendAndConfirmTransaction(conn, tx, [fee], { commitment: "confirmed" });
  console.log(`\nsent: ${sig}`);
}

if (process.argv[1]?.endsWith("wallets-fund.ts")) {
  main().catch((e) => {
    console.error("\n" + ((e as Error).message ?? e));
    process.exit(1);
  });
}
