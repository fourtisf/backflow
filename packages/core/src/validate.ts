/**
 * Launch form validation shared by the web form and the API (SPEC §4).
 */
import { BRAND } from "./brand";

export const LAUNCH_LIMITS = {
  nameMin: 2,
  nameMax: 32,
  tickerMin: 1,
  tickerMax: 10,
  descriptionMax: 140,
  imageMaxBytes: 4 * 1024 * 1024,
  imageTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] as readonly string[],
} as const;

/** Uppercase and strip anything that is not A–Z or 0–9. */
export function normalizeTicker(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, LAUNCH_LIMITS.tickerMax);
}

/** Lowercase key used for case-insensitive uniqueness on Backflow. */
/**
 * The uniqueness key of a ticker. Look-alike characters share one key, so a copycat can't launch B0NK next
 * to BONK or 5OL next to SOL (audit): 0→o, 1/l→i, 5→s, 8→b.
 */
export function tickerKey(ticker: string): string {
  return ticker.trim().toLowerCase().replace(/0/g, "o").replace(/[1l]/g, "i").replace(/5/g, "s").replace(/8/g, "b");
}

const TICKER_RE = new RegExp(`^[A-Z0-9]{${LAUNCH_LIMITS.tickerMin},${LAUNCH_LIMITS.tickerMax}}$`);

export function isValidTicker(t: string): boolean {
  return TICKER_RE.test(t);
}

export function duplicateTickerMessage(ticker: string): string {
  return `$${ticker} already exists on ${BRAND.name}. Pick another ticker.`;
}

/** A ticker an admin reserved for specific wallets (the official token; D-057). */
export function reservedTickerMessage(ticker: string): string {
  return `$${ticker} is reserved for the official ${BRAND.name} token. Pick another ticker.`;
}

/** Another wallet started launching this ticker in the last 2 minutes (D-057). */
export function launchingTickerMessage(ticker: string): string {
  return `Someone is launching $${ticker} right now. If they don't finish, it frees up within 2 minutes.`;
}

export function validateName(name: string): string | null {
  const n = name.trim();
  if (n.length < LAUNCH_LIMITS.nameMin || n.length > LAUNCH_LIMITS.nameMax) {
    return `Give your coin a name, ${LAUNCH_LIMITS.nameMin} to ${LAUNCH_LIMITS.nameMax} characters.`;
  }
  // the on-chain name field is 32 bytes: accents and emoji take 2-4 bytes each (audit)
  if (new TextEncoder().encode(n).length > 32) return "That name is too long once encoded (accents and emoji count double). Shorten it.";
  return null;
}

export function validateTicker(t: string): string | null {
  if (!t) return `Add a ticker, ${LAUNCH_LIMITS.tickerMin} to ${LAUNCH_LIMITS.tickerMax} letters or numbers.`;
  if (!isValidTicker(t)) return "Letters and numbers only.";
  return null;
}

export function validateDescription(d: string): string | null {
  return d.length > LAUNCH_LIMITS.descriptionMax ? `Keep it under ${LAUNCH_LIMITS.descriptionMax} characters.` : null;
}

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Base58 Solana address shape check (32–44 chars, no 0OIl). Does not verify the key. */
export function looksLikeAddress(s: string): boolean {
  return ADDRESS_RE.test(s);
}
