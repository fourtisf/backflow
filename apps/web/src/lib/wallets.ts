"use client";

/**
 * Wallet catalog (logos, download pages, phone deep links) and the visitor's saved wallets.
 *
 * Several wallets per visitor (DECISIONS D-042): every wallet that connects is remembered on this
 * device (address and wallet name only, never a secret). One wallet is connected at a time; the
 * others can be switched to from the wallet menu, and the Rewards page can add them all up.
 */
import { create } from "zustand";
import { WALLET_ICONS, type WalletIconKey } from "./wallet-icons";

export interface WalletInfo {
  key: WalletIconKey;
  /** Name shown in the list. */
  name: string;
  /** Names the wallet uses when it registers (Wallet Standard or adapter), for matching an installed wallet. */
  aliases: string[];
  icon: string;
  download: string;
  /** Opens a page inside the wallet's own browser on a phone (only for wallets with a documented link). */
  open?: (page: string, origin: string) => string;
}

const enc = encodeURIComponent;

/** In the order shown. Deep links: VERIFY on a phone before relying on them (D-042). */
export const WALLETS: WalletInfo[] = [
  { key: "phantom", name: "Phantom", aliases: ["Phantom"], icon: WALLET_ICONS.phantom, download: "https://phantom.com/download", open: (p, o) => `https://phantom.app/ul/browse/${enc(p)}?ref=${enc(o)}` },
  { key: "solflare", name: "Solflare", aliases: ["Solflare"], icon: WALLET_ICONS.solflare, download: "https://solflare.com/download", open: (p, o) => `https://solflare.com/ul/v1/browse/${enc(p)}?ref=${enc(o)}` },
  { key: "backpack", name: "Backpack", aliases: ["Backpack"], icon: WALLET_ICONS.backpack, download: "https://backpack.app/downloads", open: (p, o) => `https://backpack.app/ul/v1/browse/${enc(p)}?ref=${enc(o)}` },
  { key: "okx", name: "OKX Wallet", aliases: ["OKX Wallet", "OKX"], icon: WALLET_ICONS.okx, download: "https://www.okx.com/web3", open: (p) => `https://www.okx.com/download?deeplink=${enc("okx://wallet/dapp/url?dappUrl=" + enc(p))}` },
  { key: "coinbase", name: "Coinbase Wallet", aliases: ["Coinbase Wallet", "Coinbase"], icon: WALLET_ICONS.coinbase, download: "https://www.coinbase.com/wallet/downloads", open: (p) => `https://go.cb-w.com/dapp?cb_url=${enc(p)}` },
  { key: "trust", name: "Trust Wallet", aliases: ["Trust", "Trust Wallet"], icon: WALLET_ICONS.trust, download: "https://trustwallet.com/download", open: (p) => `https://link.trustwallet.com/open_url?coin_id=501&url=${enc(p)}` },
  { key: "bitkeep", name: "Bitget Wallet", aliases: ["Bitget Wallet", "Bitget", "BitKeep"], icon: WALLET_ICONS.bitkeep, download: "https://web3.bitget.com/en/wallet-download", open: (p) => `https://bkcode.vip?action=dapp&url=${enc(p)}` },
  { key: "magiceden", name: "Magic Eden", aliases: ["Magic Eden", "MagicEden"], icon: WALLET_ICONS.magiceden, download: "https://wallet.magiceden.io/" },
  { key: "exodus", name: "Exodus", aliases: ["Exodus"], icon: WALLET_ICONS.exodus, download: "https://www.exodus.com/download/" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Catalog entry for a wallet name as the wallet reports it ("Bitget" and "Bitget Wallet" are the same wallet). */
export function catalogEntry(name: string | null | undefined): WalletInfo | undefined {
  if (!name) return undefined;
  const n = norm(name);
  return WALLETS.find((w) => w.aliases.some((a) => norm(a) === n));
}

/** Best logo for a wallet: our bundled copy when we know the wallet, otherwise the icon it registered. */
export function walletIcon(name: string | null | undefined, registered?: string | null): string | null {
  return catalogEntry(name)?.icon ?? (registered && /^data:image\//.test(registered) ? registered : null);
}

export const isPhone = () => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/* ------------------------------ saved wallets ------------------------------ */

export interface SavedWallet {
  address: string;
  /** Wallet name as reported when it connected (used to reconnect through the same wallet). */
  name: string;
  addedAt: number;
}

const KEY = "backflow.wallets.v1";
const MAX = 12;

function read(): SavedWallet[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((w): w is SavedWallet => !!w && typeof w.address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.address) && typeof w.name === "string")
      .slice(0, MAX)
      .map((w) => ({ address: w.address, name: w.name.slice(0, 40), addedAt: Number(w.addedAt) || 0 }));
  } catch {
    return [];
  }
}

function write(list: SavedWallet[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode or storage blocked: the list just isn't remembered */
  }
}

interface SavedState {
  list: SavedWallet[];
  loaded: boolean;
  load: () => void;
  add: (address: string, name: string) => void;
  remove: (address: string) => void;
}

export const useSavedWallets = create<SavedState>()((set, get) => ({
  list: [],
  loaded: false,
  load: () => {
    if (!get().loaded) set({ list: read(), loaded: true });
  },
  add: (address, name) => {
    const cur = get().loaded ? get().list : read();
    const existing = cur.find((w) => w.address === address);
    if (existing && existing.name === name) return;
    const list = existing ? cur.map((w) => (w.address === address ? { ...w, name } : w)) : [...cur, { address, name, addedAt: Date.now() }].slice(-MAX);
    write(list);
    set({ list, loaded: true });
  },
  remove: (address) => {
    const list = get().list.filter((w) => w.address !== address);
    write(list);
    set({ list });
  },
}));
