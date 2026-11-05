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
const BALANCE_POLL_MS = 15_000;

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
      connection
        .getBalance(publicKey, "confirmed")
        .then((b) => {
          if (!alive) return;
          setLamports(BigInt(b));
          setError(null);
        })
        .catch(() => alive && setError("Can't read balance"));
    void read();
    let sub: number | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    if (RPC_PROXIED) poll = setInterval(() => void read(), BALANCE_POLL_MS);
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
