"use client";

import type { LiveEvent } from "@backflow/core";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { BitgetWalletAdapter } from "@solana/wallet-adapter-bitkeep";
import { CoinbaseWalletAdapter } from "@solana/wallet-adapter-coinbase";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { TrustWalletAdapter } from "@solana/wallet-adapter-trust";
import { clusterApiUrl } from "@solana/web3.js";
import { useEffect, useMemo, type ReactNode } from "react";
import { wsUrl } from "@/lib/api";
import { emitLive, loadShellData, useLive } from "@/lib/store";

export const CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet") as "devnet" | "mainnet-beta";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl(CLUSTER);

/** Opens the /live WebSocket, batches events into the store, reconnects with backoff. */
function LiveConnection() {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queue: LiveEvent[] = [];
    let flushT: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      flushT = undefined;
      const q = queue;
      queue = [];
      if (q.length) useLive.getState().applyEvents(q);
    };

    const connect = () => {
      if (stopped) return;
      useLive.getState().setWs("connecting");
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        retry = 0;
        useLive.getState().setWs("open");
        void loadShellData();
      };
      ws.onmessage = (m) => {
        let e: LiveEvent;
        try {
          e = JSON.parse(String(m.data)) as LiveEvent;
        } catch {
          return;
        }
        if (e.type === "hello") useLive.getState().setStats(e.stats);
        emitLive(e);
        queue.push(e);
        if (!flushT) flushT = setTimeout(flush, 250);
      };
      ws.onclose = () => {
        useLive.getState().setWs("closed");
        schedule();
      };
      ws.onerror = () => ws?.close();
    };
    const schedule = () => {
      if (stopped) return;
      const delay = Math.min(15000, 1000 * 2 ** retry++);
      timer = setTimeout(connect, delay);
    };

    void loadShellData();
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(flushT);
      ws?.close();
    };
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  // Phantom and Solflare adapters are explicit; Backpack and other Wallet
  // Standard wallets are detected automatically.
  // Wallets that register through Wallet Standard (Backpack, OKX, Magic Eden, Exodus, …) are detected on their own;
  // these adapters also cover older versions that don't (a Standard wallet with the same name replaces its adapter).
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new CoinbaseWalletAdapter(), new TrustWalletAdapter(), new BitgetWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <LiveConnection />
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
