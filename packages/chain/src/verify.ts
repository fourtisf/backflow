/**
 * Client-side check of a server-built transaction before the wallet signs it
 * (audit L8, defense in depth). The web runs this in signAndSend: if the API
 * were compromised, or reached over a tampered connection, a Buy, Launch or
 * Claim click must not turn into a signature on someone else's transaction.
 *
 * Pure: imports only @solana/web3.js and @backflow/core, so the browser bundle
 * stays free of node-only modules (import it as "@backflow/chain/verify").
 *
 * What Backflow's user transactions contain (packages/chain/src/tx.ts):
 *   ComputeBudget limit/price; ATA create-idempotent for the user's own token
 *   accounts; System transfer into the user's own wSOL account + SyncNative;
 *   one LaunchLab instruction (initialize_v2, buy, sell, claim creator fee) or
 *   one CPMM instruction (swap, collect creator fee); CloseAccount of the wSOL
 *   account back to the user. Anything else is refused.
 */
import { RAYDIUM, WSOL_MINT, type Cluster } from "@backflow/core";
import { ComputeBudgetProgram, PublicKey, SystemProgram, type VersionedTransaction } from "@solana/web3.js";

export const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WSOL = new PublicKey(WSOL_MINT);

/** Highest priority fee accepted, in micro-lamports per compute unit (0.014 SOL at 1.4 M CU). */
export const MAX_PRIORITY_MICROLAMPORTS = 10_000_000n;

export interface UserTxPrograms {
  launchLab: string;
  cpmm: string;
}

export function userTxPrograms(cluster: Cluster): UserTxPrograms {
  const r = RAYDIUM[cluster];
  return { launchLab: r.launchLabProgram, cpmm: r.cpmmProgram };
}

export type UserTxCheck = { ok: true } | { ok: false; reason: string };

const SPL = { closeAccount: 9, syncNative: 17, approve: 4, approveChecked: 13, setAuthority: 6 } as const;

function u32le(d: Uint8Array, at: number): number | null {
  return d.length >= at + 4 ? (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16)) + d[at + 3]! * 0x1000000 : null;
}

function u64le(d: Uint8Array, at: number): bigint | null {
  if (d.length < at + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]!);
  return v;
}

export function wsolAccountOf(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([user.toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), WSOL.toBuffer()], ATA_PROGRAM)[0];
}

/**
 * Checks that `tx` is the kind of transaction Backflow builds for `user`:
 * - the fee payer is the user;
 * - every top-level program is ComputeBudget, System, SPL Token, Associated Token, or the cluster's LaunchLab/CPMM;
 * - SPL Token: only SyncNative and CloseAccount, and CloseAccount pays the rent back to the user
 *   (so no Approve, ApproveChecked, SetAuthority, Transfer or Burn);
 * - System: only Transfer, and only into the user's own wSOL account;
 * - Associated Token: only Create/CreateIdempotent paid by and owned by the user;
 * - a sane priority fee.
 * Accounts that are checked must be static keys: an address loaded from a lookup table can't be checked
 * offline, so it is refused there.
 */
export function checkUserTx(tx: VersionedTransaction, user: PublicKey, programs: UserTxPrograms): UserTxCheck {
  const fail = (reason: string): UserTxCheck => ({ ok: false, reason });
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (!keys.length || !keys[0]!.equals(user)) return fail("the fee payer isn't the connected wallet");
  const at = (i: number | undefined): PublicKey | null => (i != null && i >= 0 && i < keys.length ? keys[i]! : null);
  const allowed = new Set([ComputeBudgetProgram.programId.toBase58(), SystemProgram.programId.toBase58(), SPL_TOKEN_PROGRAM.toBase58(), ATA_PROGRAM.toBase58(), programs.launchLab, programs.cpmm]);
  const wsol = wsolAccountOf(user);
  const ixs = msg.compiledInstructions;
  if (!ixs.length) return fail("the transaction is empty");

  for (const ix of ixs) {
    const program = at(ix.programIdIndex);
    if (!program) return fail("a program id is not a static key");
    const p = program.toBase58();
    if (!allowed.has(p)) return fail(`unexpected program ${p}`);
    const d = ix.data;
    const acc = (n: number) => at(ix.accountKeyIndexes[n]);

    if (program.equals(ComputeBudgetProgram.programId)) {
      const kind = d[0];
      if (kind === 3) {
        const price = u64le(d, 1);
        if (price == null || price > MAX_PRIORITY_MICROLAMPORTS) return fail("the priority fee is unusually high");
      } else if (kind !== 1 && kind !== 2 && kind !== 4) return fail("unexpected compute budget instruction");
      continue;
    }

    if (program.equals(SystemProgram.programId)) {
      if (u32le(d, 0) !== 2) return fail("unexpected System instruction (only transfers into your wSOL account are expected)");
      const from = acc(0);
      const to = acc(1);
      if (!from || !from.equals(user)) return fail("a SOL transfer doesn't come from your wallet");
      if (!to || !to.equals(wsol)) return fail("a SOL transfer goes to an account that isn't your own wSOL account");
      continue;
    }

    if (program.equals(SPL_TOKEN_PROGRAM)) {
      const kind = d[0];
      if (kind === SPL.syncNative) continue;
      if (kind === SPL.closeAccount) {
        const dest = acc(1);
        if (!dest || !dest.equals(user)) return fail("a token account is closed to someone else's wallet");
        continue;
      }
      if (kind === SPL.approve || kind === SPL.approveChecked) return fail("it would let someone else spend your tokens (Approve)");
      if (kind === SPL.setAuthority) return fail("it would change who controls one of your token accounts (SetAuthority)");
      return fail(`unexpected token instruction ${kind ?? "?"}`);
    }

    if (program.equals(ATA_PROGRAM)) {
      if (!(d.length === 0 || d[0] === 0 || d[0] === 1)) return fail("unexpected associated token instruction");
      const payer = acc(0);
      const owner = acc(2);
      if (!payer || !payer.equals(user) || !owner || !owner.equals(user)) return fail("it creates a token account for someone else");
      continue;
    }
    // LaunchLab and CPMM instructions: allowed program, built by the API from on-chain pool data.
  }
  return { ok: true };
}
