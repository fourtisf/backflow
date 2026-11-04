/**
 * Optional Jupiter buybacks (JUPITER_BUYBACKS=1). The buyback key never signs a
 * transaction built by someone else: we fetch Jupiter's *instructions*, check
 * every one against an allowlist, compile the transaction ourselves with our own
 * payer, blockhash and compute budget, then simulate and check balance effects.
 */
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export interface JupIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

export interface JupSwapInstructions {
  computeBudgetInstructions?: JupIx[];
  setupInstructions?: JupIx[];
  swapInstruction?: JupIx;
  cleanupInstruction?: JupIx | null;
  addressLookupTableAddresses?: string[];
}

const toIx = (j: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(j.programId),
    keys: j.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(j.data, "base64"),
  });

/**
 * Validates Jupiter's instructions for a SOL → coin swap paid by `payer` into `destination`.
 * Returns the instructions to use (Jupiter's compute-budget instructions are dropped; we set our own).
 * Throws with a reason on anything unexpected.
 */
export function checkJupiterInstructions(r: JupSwapInstructions, payer: PublicKey, destination: PublicKey): TransactionInstruction[] {
  if (!r.swapInstruction) throw new Error("jupiter: no swap instruction");
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer, true);
  const P = payer.toBase58();
  const all = [...(r.setupInstructions ?? []), r.swapInstruction, ...(r.cleanupInstruction ? [r.cleanupInstruction] : [])];
  for (const j of all) {
    for (const a of j.accounts) if (a.isSigner && a.pubkey !== P) throw new Error(`jupiter: unexpected signer ${a.pubkey}`);
  }
  const check = (j: JupIx, role: "setup" | "swap" | "cleanup") => {
    const d = Buffer.from(j.data, "base64");
    if (role === "swap") {
      if (j.programId !== JUPITER_V6) throw new Error(`jupiter: swap program ${j.programId} not allowed`);
      if (!j.accounts.some((a) => a.pubkey === destination.toBase58())) throw new Error("jupiter: swap does not pay the distributor");
      return;
    }
    if (j.programId === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
      // create / create-idempotent: [payer, ata, owner, mint, system, token]; only for the payer's own accounts or the destination
      const target = j.accounts[1]?.pubkey;
      if (j.accounts[0]?.pubkey !== P || (target !== wsol.toBase58() && target !== destination.toBase58())) throw new Error("jupiter: unexpected token account creation");
      return;
    }
    if (j.programId === SystemProgram.programId.toBase58()) {
      // transfer (2) into the payer's own wSOL account only
      if (d.readUInt32LE(0) !== 2 || j.accounts[0]?.pubkey !== P || j.accounts[1]?.pubkey !== wsol.toBase58()) throw new Error("jupiter: unexpected system instruction");
      return;
    }
    if (j.programId === TOKEN_PROGRAM_ID.toBase58()) {
      const op = d[0];
      if (op === 17 && j.accounts[0]?.pubkey === wsol.toBase58()) return; // SyncNative on our wSOL
      if (op === 9 && j.accounts[0]?.pubkey === wsol.toBase58() && j.accounts[1]?.pubkey === P) return; // CloseAccount wSOL → payer
      throw new Error(`jupiter: token instruction ${op} not allowed`);
    }
    throw new Error(`jupiter: ${role} program ${j.programId} not allowed`);
  };
  for (const j of r.setupInstructions ?? []) check(j, "setup");
  check(r.swapInstruction, "swap");
  if (r.cleanupInstruction) check(r.cleanupInstruction, "cleanup");
  return all.map(toIx);
}

/** Token amount from raw SPL token account data (offset 64, u64 LE). */
export const tokenAmountOf = (data: Buffer): bigint => (data.length >= 72 ? data.readBigUInt64LE(64) : 0n);
