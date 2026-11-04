/**
 * Sending with the safety rules from SPEC §9 and CLAUDE.md rule 5:
 * simulate first, record the signature BEFORE broadcasting, and never resend
 * without checking whether the previous attempt landed.
 */
import {
  PublicKey,
  type AddressLookupTableAccount,
  type Connection,
  type Keypair,
  type TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { compile } from "./tx";

export type LandedStatus = "confirmed" | "failed" | "pending" | "dropped";

export interface PreparedTx {
  tx: VersionedTransaction;
  signature: string;
  lastValidBlockHeight: number;
}

/** Build, sign and simulate. The signature is known before anything is sent, so callers can persist it first. */
export async function prepare(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], extraSigners: Keypair[] = [], luts: AddressLookupTableAccount[] = []): Promise<PreparedTx> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = compile(payer.publicKey, ixs, blockhash, luts);
  tx.sign([payer, ...extraSigners]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).slice(-8).join("\n");
    throw new SimulationError(`simulation failed: ${JSON.stringify(sim.value.err)}\n${logs}`, sim.value.logs ?? []);
  }
  return { tx, signature: bs58.encode(tx.signatures[0]!), lastValidBlockHeight };
}

/** Sign and simulate an already-built transaction (e.g. one returned by Jupiter's swap API). */
export async function prepareBuilt(conn: Connection, tx: VersionedTransaction, signers: Keypair[]): Promise<PreparedTx> {
  // Use our own blockhash so the stored lastValidBlockHeight really belongs to this transaction.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  tx.signatures = tx.signatures.map(() => new Uint8Array(64));
  tx.sign(signers);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (sim.value.err) throw new SimulationError(`simulation failed: ${JSON.stringify(sim.value.err)}`, sim.value.logs ?? []);
  return { tx, signature: bs58.encode(tx.signatures[0]!), lastValidBlockHeight };
}

export class SimulationError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
  }
}

/** Broadcast a prepared transaction (idempotent: the same signed bytes can be sent repeatedly). */
export async function broadcast(conn: Connection, p: PreparedTx): Promise<void> {
  await conn.sendRawTransaction(p.tx.serialize(), { skipPreflight: true, maxRetries: 3 });
}

/**
 * Blocks past lastValidBlockHeight before a transaction counts as dropped. Measured against the
 * *finalized* height (which already trails the tip by ~32 slots), so a lagging or forked RPC node
 * can't make a landed transaction look expired and get it refunded or resent.
 */
export const DROP_MARGIN_BLOCKS = 20;

async function expired(conn: Connection, lastValidBlockHeight: number): Promise<boolean> {
  const finalized = await conn.getBlockHeight("finalized");
  return finalized > lastValidBlockHeight + DROP_MARGIN_BLOCKS;
}

/** Wait until confirmed, failed, or the blockhash has expired for certain (then it can never land). */
export async function waitForLanding(conn: Connection, signature: string, lastValidBlockHeight: number, timeoutMs = 90_000): Promise<LandedStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await statusOf(conn, signature);
    if (s === "confirmed" || s === "failed") return s;
    if (await expired(conn, lastValidBlockHeight)) {
      // one last look after the finalized height passed: it may have landed right at the edge
      const last = await statusOf(conn, signature);
      return last === "pending" ? "dropped" : last;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return "pending";
}

/**
 * Current status of a signature, searching transaction history so old signatures are found too.
 * An error only counts as final once the transaction is confirmed: a "processed" result can come
 * from a minority fork while the same signed bytes still land on the main fork.
 */
export async function statusOf(conn: Connection, signature: string): Promise<LandedStatus> {
  const r = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const st = r.value[0];
  if (!st) return "pending";
  const final = st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized";
  if (!final) return "pending";
  return st.err ? "failed" : "confirmed";
}

/**
 * Before retrying a job that already has a signature: confirmed → done; failed → safe to retry;
 * pending with an unexpired blockhash → wait; otherwise dropped → safe to retry.
 */
export async function checkPrevious(conn: Connection, signature: string, lastValidBlockHeight: number | null): Promise<LandedStatus> {
  const s = await statusOf(conn, signature);
  if (s !== "pending") return s;
  if (lastValidBlockHeight == null) return "pending";
  if (!(await expired(conn, lastValidBlockHeight))) return "pending";
  const last = await statusOf(conn, signature);
  return last === "pending" ? "dropped" : last;
}

export async function loadLuts(conn: Connection, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const a of addresses) {
    const r = await conn.getAddressLookupTable(new PublicKey(a));
    if (r.value) out.push(r.value);
  }
  return out;
}
