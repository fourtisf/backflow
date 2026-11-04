"use client";

import { COPY, ppmPct, type StatsDTO } from "@backflow/core";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { VersionedTransaction, type Connection } from "@solana/web3.js";
import { API_URL, ApiError } from "./api";
import { useLive } from "./store";

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Can't reach the Backflow API.");
  }
  const j = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ApiError(res.status, j.message ?? `Request failed (${res.status}).`);
  return j as T;
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, { method: "POST", body: form });
  } catch {
    throw new ApiError(0, "Can't reach the Backflow API.");
  }
  const j = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ApiError(res.status, j.message ?? `Upload failed (${res.status}).`);
  return j as T;
}

export const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet";

export function explorerTx(sig: string): string {
  return `https://solscan.io/tx/${sig}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`}`;
}

/** Explorer links only make sense for real signatures. */
export function useExplorerLinks(): boolean {
  return useLive((s) => s.stats?.mode === "live");
}

/**
 * Sign a server-built transaction in the wallet (keeping any signatures already on it,
 * e.g. the new mint's) and send it. Resolves when confirmed; rejects with plain copy.
 */
export async function signAndSend(wallet: WalletContextState, connection: Connection, base64: string): Promise<string> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  // no Buffer global in the browser
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(bytes);
  let signature: string;
  try {
    if (wallet.signTransaction) {
      const signed = await wallet.signTransaction(tx);
      signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
    } else {
      signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false, maxRetries: 3 });
    }
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/reject|cancel|denied/i.test(msg)) throw new Error("You cancelled it in your wallet. Nothing was sent.");
    if (/insufficient|0x1\b/i.test(msg)) throw new Error("Not enough SOL for this transaction and its network fee.");
    if (/slippage|0x1771|exceeds desired/i.test(msg)) throw new Error("The price moved more than your slippage. Try again or raise slippage.");
    throw new Error(msg.length > 140 ? "The transaction failed. Try again." : msg || "The transaction failed.");
  }
  const start = Date.now();
  while (Date.now() - start < 75_000) {
    const st = (await connection.getSignatureStatuses([signature])).value[0];
    if (st?.err) throw new Error("The transaction failed on chain. Nothing changed.");
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Still waiting for confirmation. Check your wallet history before trying again.");
}

/**
 * Fee copy for the UI. If the live chain fees differ from config (e.g. Raydium's protocol fee is not
 * 0.25%), show the real numbers (SPEC §2.1: surface the real total, never change rates silently).
 */
export function feeCopy(stats: StatsDTO | null) {
  const f = stats?.liveFees;
  if (!f) return { ...COPY, differs: false };
  const total = ppmPct(BigInt(f.totalPpm));
  return { ...COPY, total, raydium: ppmPct(BigInt(f.raydiumPpm)), creator: ppmPct(BigInt(f.creatorPpm)), differs: total !== COPY.total };
}

export function useFeeCopy() {
  return feeCopy(useLive((s) => s.stats));
}

const SLIP_KEY = "backflow:slippageBps";
export function loadSlippage(): number {
  try {
    const v = Number(localStorage.getItem(SLIP_KEY));
    return Number.isInteger(v) && v > 0 && v <= 5000 ? v : 100;
  } catch {
    return 100;
  }
}
export function saveSlippage(bps: number) {
  try {
    localStorage.setItem(SLIP_KEY, String(bps));
  } catch {
    /* private mode */
  }
}
