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
export function tickerKey(ticker: string): string {
  return ticker.trim().toLowerCase();
}

const TICKER_RE = new RegExp(`^[A-Z0-9]{${LAUNCH_LIMITS.tickerMin},${LAUNCH_LIMITS.tickerMax}}$`);

export function isValidTicker(t: string): boolean {
  return TICKER_RE.test(t);
}

export function duplicateTickerMessage(ticker: string): string {
  return `$${ticker} already exists on ${BRAND.name}. Pick another ticker.`;
}

export function validateName(name: string): string | null {
  const n = name.trim();
  if (n.length < LAUNCH_LIMITS.nameMin || n.length > LAUNCH_LIMITS.nameMax) {
    return `Give your coin a name, ${LAUNCH_LIMITS.nameMin} to ${LAUNCH_LIMITS.nameMax} characters.`;
  }
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
