"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { useLive } from "./store";

/** Re-render every `ms` and return Date.now(). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Seconds until the next payout, using server time. null when unknown. */
export function usePayoutCountdown(): number | null {
  const now = useNow(1000);
  const next = useLive((s) => s.stats?.nextPayoutAt);
  const skew = useLive((s) => s.clockSkew);
  if (!next) return null;
  return Math.max(0, (Date.parse(next) - (now + skew)) / 1000);
}

export function useReducedMotion(): boolean {
  const [r, setR] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(m.matches);
    const fn = () => setR(m.matches);
    m.addEventListener?.("change", fn);
    return () => m.removeEventListener?.("change", fn);
  }, []);
  return r;
}

/**
 * The site's RPC is our own /api/rpc proxy (D-047): plain JSON-RPC, no WebSocket, so balances are polled
 * instead of subscribed.
 */
const RPC_PROXIED = (process.env.NEXT_PUBLIC_RPC_URL ?? "").replace(/\/+$/, "").endsWith("/api/rpc");
const BALANCE_POLL_MS = 30_000;
/** Several components show the same balance: they share one RPC read per wallet per 10 s (audit). */
const balanceReads = new Map<string, { at: number; p: Promise<number> }>();
function sharedBalance(connection: { getBalance: (k: import("@solana/web3.js").PublicKey, c: "confirmed") => Promise<number> }, key: import("@solana/web3.js").PublicKey): Promise<number> {
  const id = key.toBase58();
  const hit = balanceReads.get(id);
  if (hit && Date.now() - hit.at < 10_000) return hit.p;
  const p = connection.getBalance(key, "confirmed");
  balanceReads.set(id, { at: Date.now(), p });
  p.catch(() => balanceReads.delete(id));
  return p;
}

/**
 * The connected wallet's balance of one coin, read from chain (all its token accounts of that mint), so
 * selling never waits for the indexer (D-055). Refreshed every 10 s, and at once after `bump()`.
 */
export function useTokenBalance(mint: string): { units: bigint | null; bump: () => void } {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [units, setUnits] = useState<bigint | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    setUnits(null);
    if (!publicKey) return;
    let alive = true;
    const read = async () => {
      try {
        const { PublicKey } = await import("@solana/web3.js");
        const r = await connection.getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(mint) }, "confirmed");
        let sum = 0n;
        for (const a of r.value) {
          const amt = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
          if (amt) sum += BigInt(amt);
        }
        if (alive) setUnits(sum);
      } catch {
        /* keep the last value; the indexer's number is the fallback */
      }
    };
    void read();
    const t = setInterval(() => document.hidden || void read(), 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connection, publicKey, mint, n]);
  return { units, bump: () => setN((x) => x + 1) };
}

/** Connected wallet's SOL balance in lamports, live from the RPC. */
export function useSolBalance(): { lamports: bigint | null; error: string | null } {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [lamports, setLamports] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLamports(null);
    setError(null);
    if (!publicKey) return;
    let alive = true;
    const read = () =>
      sharedBalance(connection, publicKey)
        .then((b) => {
          if (!alive) return;
          setLamports(BigInt(b));
          setError(null);
        })
        .catch(() => alive && setError("Can't read balance"));
    void read();
    let sub: number | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    // polled through our own RPC: every 30 s, and not while the tab is in the background (audit)
    if (RPC_PROXIED) poll = setInterval(() => document.hidden || void read(), BALANCE_POLL_MS);
    else {
      try {
        sub = connection.onAccountChange(publicKey, (acc) => alive && setLamports(BigInt(acc.lamports)), "confirmed");
      } catch {
        /* websocket unavailable; the initial read still works */
      }
    }
    return () => {
      alive = false;
      if (poll) clearInterval(poll);
      if (sub != null) void connection.removeAccountChangeListener(sub).catch(() => {});
    };
  }, [connection, publicKey]);
  return { lamports, error };
}
