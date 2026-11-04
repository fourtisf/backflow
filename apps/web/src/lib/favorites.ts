"use client";

import { create } from "zustand";

const KEY = "backflow:watchlist";

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}

interface FavState {
  mints: string[];
  ready: boolean;
  init: () => void;
  toggle: (mint: string) => void;
}

/** Watchlist kept in this browser only (no account needed). */
export const useFavorites = create<FavState>()((set, get) => ({
  mints: [],
  ready: false,
  init: () => {
    if (!get().ready) set({ mints: load(), ready: true });
  },
  toggle: (mint) => {
    const has = get().mints.includes(mint);
    const mints = has ? get().mints.filter((m) => m !== mint) : [mint, ...get().mints].slice(0, 50);
    set({ mints });
    try {
      localStorage.setItem(KEY, JSON.stringify(mints));
    } catch {
      /* private mode */
    }
  },
}));
