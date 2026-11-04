"use client";

import type { BuybackDTO, CoinRow, LiveEvent, StatsDTO, WalletRewardsDTO } from "@backflow/core";
import type { ReactNode } from "react";
import { create } from "zustand";
import { apiGet } from "./api";

/* -------------------------------- event bus -------------------------------- */

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe to live events as they arrive (before batching). */
export function onLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function emitLive(e: LiveEvent): void {
  for (const fn of listeners) fn(e);
}

/* -------------------------------- live store ------------------------------- */

export type WsStatus = "connecting" | "open" | "closed";

interface LiveState {
  ws: WsStatus;
  apiError: string | null;
  stats: StatsDTO | null;
  /** serverTime − Date.now(), so countdowns use server time. */
  clockSkew: number;
  coins: Record<string, CoinRow>;
  buybackCounts: Record<string, number>;
  ledger: BuybackDTO[];
  ledgerLoaded: boolean;
  setWs: (s: WsStatus) => void;
  setApiError: (e: string | null) => void;
  setStats: (s: StatsDTO) => void;
  upsertCoins: (rows: CoinRow[]) => void;
  setLedger: (rows: BuybackDTO[]) => void;
  applyEvents: (events: LiveEvent[]) => void;
}

const LEDGER_MAX = 80;

export const useLive = create<LiveState>()((set) => ({
  ws: "connecting",
  apiError: null,
  stats: null,
  clockSkew: 0,
  coins: {},
  buybackCounts: {},
  ledger: [],
  ledgerLoaded: false,
  setWs: (ws) => set({ ws }),
  setApiError: (apiError) => set({ apiError }),
  setStats: (stats) => set({ stats, clockSkew: Date.parse(stats.serverTime) - Date.now(), apiError: null }),
  upsertCoins: (rows) =>
    set((s) => {
      const coins = { ...s.coins };
      for (const r of rows) coins[r.mint] = r;
      return { coins };
    }),
  setLedger: (ledger) => set({ ledger, ledgerLoaded: true }),
  applyEvents: (events) =>
    set((s) => {
      let coins = s.coins;
      let ledger = s.ledger;
      let stats = s.stats;
      let buybackCounts = s.buybackCounts;
      const touch = (mint: string): CoinRow | null => {
        const c = coins[mint];
        if (!c) return null;
        if (coins === s.coins) coins = { ...s.coins };
        const copy = { ...c };
        coins[mint] = copy;
        return copy;
      };
      for (const e of events) {
        switch (e.type) {
          case "hello":
            stats = e.stats;
            break;
          case "price": {
            const c = touch(e.mint);
            if (!c) break;
            c.mcapUsd = e.mcapUsd;
            c.change24hPct = e.change24hPct;
            c.vol24hUsd = e.vol24hUsd;
            c.curveQuoteLamports = e.curveQuoteLamports;
            c.holderCount = e.holderCount;
            if (e.mcapUsd != null && c.spark.length) {
              c.spark = [...c.spark];
              c.spark[c.spark.length - 1] = e.mcapUsd;
            }
            break;
          }
          case "vault": {
            const c = touch(e.mint);
            if (c) c.buybackBudgetLamports = e.buybackBudgetLamports;
            break;
          }
          case "buyback": {
            ledger = [e.buyback, ...ledger.filter((b) => b.id !== e.buyback.id)].slice(0, LEDGER_MAX);
            const c = touch(e.buyback.coinMint);
            if (c) c.paidToHoldersLamports = e.paidToHoldersLamports;
            if (buybackCounts === s.buybackCounts) buybackCounts = { ...s.buybackCounts };
            buybackCounts[e.buyback.coinMint] = e.buybackCount;
            if (stats) stats = { ...stats, totalPaidLamports: (BigInt(stats.totalPaidLamports) + BigInt(e.buyback.solSpentLamports)).toString() };
            break;
          }
          case "graduated": {
            const c = touch(e.mint);
            if (c) c.status = "graduated";
            break;
          }
          case "coin_created":
            if (coins === s.coins) coins = { ...s.coins };
            coins[e.coin.mint] = e.coin;
            break;
          case "payout":
            if (stats) stats = { ...stats, nextPayoutAt: e.nextPayoutAt };
            break;
          case "trade":
            break;
        }
      }
      return { coins, ledger, stats, buybackCounts };
    }),
}));

/** Fetch the global data the shell needs. */
export async function loadShellData(): Promise<void> {
  const st = useLive.getState();
  try {
    const [stats, bbs, list] = await Promise.all([
      apiGet<StatsDTO>("/stats"),
      apiGet<{ buybacks: BuybackDTO[] }>("/buybacks?limit=40"),
      apiGet<{ coins: CoinRow[] }>("/coins?tab=trending"),
    ]);
    st.setStats(stats);
    st.setLedger(bbs.buybacks);
    st.upsertCoins(list.coins);
  } catch (e) {
    st.setApiError((e as Error).message || "Can't reach the Backflow API.");
  }
}

/* ------------------------------- rewards store ------------------------------ */

interface RewardsState {
  wallet: string | null;
  data: WalletRewardsDTO | null;
  error: string | null;
  loading: boolean;
  load: (wallet: string) => Promise<void>;
  clear: () => void;
}

export const useRewards = create<RewardsState>()((set, get) => ({
  wallet: null,
  data: null,
  error: null,
  loading: false,
  load: async (wallet) => {
    if (get().wallet !== wallet) set({ wallet, data: null });
    set({ loading: true });
    try {
      const data = await apiGet<WalletRewardsDTO>(`/wallet/${wallet}/rewards`);
      if (get().wallet === wallet) set({ data, error: null });
    } catch (e) {
      if (get().wallet === wallet) set({ error: (e as Error).message });
    } finally {
      if (get().wallet === wallet) set({ loading: false });
    }
  },
  clear: () => set({ wallet: null, data: null, error: null, loading: false }),
}));

/* --------------------------------- toasts ---------------------------------- */

export interface ToastItem {
  id: number;
  body: ReactNode;
  bad: boolean;
  leaving: boolean;
}

interface ToastState {
  items: ToastItem[];
  push: (body: ReactNode, bad?: boolean) => void;
}

let toastSeq = 0;

export const useToasts = create<ToastState>()((set) => ({
  items: [],
  push: (body, bad = false) => {
    const id = ++toastSeq;
    set((s) => ({ items: [...s.items, { id, body, bad, leaving: false }].slice(-3) }));
    setTimeout(() => {
      set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
      setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 320);
    }, 4200);
  },
}));

export function toast(body: ReactNode, bad = false): void {
  useToasts.getState().push(body, bad);
}

/* ----------------------------------- ui ------------------------------------ */

interface UiState {
  walletModal: boolean;
  /** "add": the visitor is adding another wallet next to the connected one. */
  walletModalMode: "connect" | "add";
  openWalletModal: () => void;
  openAddWallet: () => void;
  closeWalletModal: () => void;
}

export const useUi = create<UiState>()((set) => ({
  walletModal: false,
  walletModalMode: "connect",
  openWalletModal: () => set({ walletModal: true, walletModalMode: "connect" }),
  openAddWallet: () => set({ walletModal: true, walletModalMode: "add" }),
  closeWalletModal: () => set({ walletModal: false }),
}));
