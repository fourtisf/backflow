/**
 * Display formatting. These turn base units and derived numbers into strings
 * for the UI. They mirror the helpers in prototype/backflow.html so the copy
 * reads the same.
 */
import { CURVE, LAMPORTS_PER_SOL, PPM, SOL_DECIMALS } from "./fees";
import { formatUnits, toDisplayNumber } from "./math";

const DASH = "–";

/** "$1.23M", "$45.6K", "$12", "$0.0042" */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return "$" + (n / 1e3).toFixed(1) + "K";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  if (a >= 100) return "$" + Math.round(n);
  if (a >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

/** Compact number: "18.4M", "212K", "96", "0.42" */
export function cnum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  if (!n) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(1) + "K";
  if (a >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return a >= 100 ? Math.round(n).toString() : n.toFixed(a >= 1 ? 2 : 4);
}

/** "1,234" */
export function int(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return Math.round(n).toLocaleString("en-US");
}

/** SOL amount (as a number of SOL) with the prototype's precision rules. */
export function solNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
}

/** Lamports → SOL string with the prototype's precision rules ("1.00", "0.0045" shows as "0.005"). */
export function sol(lamports: bigint | string | null | undefined): string {
  if (lamports == null) return DASH;
  const v = typeof lamports === "string" ? BigInt(lamports) : lamports;
  return solNum(toDisplayNumber(v, SOL_DECIMALS));
}

/** Lamports → exact SOL ("0.0045", "1"). For fee examples where precision matters. */
export function solExact(lamports: bigint): string {
  return formatUnits(lamports, SOL_DECIMALS);
}

/** Lamports → SOL with a fixed number of decimals ("0.42", "1.00"). Rounds down. */
export function solFixed(lamports: bigint | string, digits = 2): string {
  const v = typeof lamports === "string" ? BigInt(lamports) : lamports;
  const step = 10n ** BigInt(SOL_DECIMALS - digits);
  const floored = (v / step) * step;
  const [w, f = ""] = formatUnits(floored, SOL_DECIMALS).split(".");
  return digits > 0 ? `${w}.${f.padEnd(digits, "0").slice(0, digits)}` : (w ?? "0");
}

/** Token base units → compact number ("18.4M"). */
export function tokens(amount: bigint | string | null | undefined, decimals: number = CURVE.decimals): string {
  if (amount == null) return DASH;
  const v = typeof amount === "string" ? BigInt(amount) : amount;
  return cnum(toDisplayNumber(v, decimals));
}

/** "+12.3%" / "-4.0%" */
export function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return (n > 0 ? "+" : "") + n.toFixed(1) + "%";
}

/**
 * Parts-per-million rate → percent string with no float error and trailing
 * zeros trimmed. 4500 → "0.45%", 2250 → "0.225%", 11000 → "1.1%".
 */
export function ppmPct(ppm: bigint | number, withSign = true): string {
  const v = typeof ppm === "number" ? BigInt(Math.round(ppm)) : ppm;
  // percent = ppm / 10_000
  const s = formatUnits(v, 4);
  return withSign ? s + "%" : s;
}

/** "12s ago", "4m ago", "3h ago", "2d ago" */
export function ago(ms: number, now: number = Date.now()): string {
  const s = Math.max(1, Math.round((now - ms) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

/** "4:05" */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/** "Gq4m…8VtZ" */
export function short(addr: string): string {
  return addr.length <= 10 ? addr : addr.slice(0, 4) + "…" + addr.slice(-4);
}

/** Human interval for copy: 60 → "minute", 300 → "5 minutes", 3600 → "hour". */
export function everyInterval(sec: number): string {
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return h === 1 ? "hour" : `${h} hours`;
  }
  if (sec % 60 === 0) {
    const m = sec / 60;
    return m === 1 ? "minute" : `${m} minutes`;
  }
  return sec === 1 ? "second" : `${sec} seconds`;
}

/** Whole SOL for copy: 85_000_000_000n → "85", 1_000_000_000n → "1". */
export function solWhole(lamports: bigint): string {
  return formatUnits(lamports, SOL_DECIMALS);
}

/** Integer supply for copy: 1000000000 → "1,000,000,000". */
export function supplyText(): string {
  return CURVE.supplyTokens.toLocaleString("en-US");
}

/** "1 billion" style for copy. */
export function supplyWords(): string {
  const n = CURVE.supplyTokens;
  if (n % 1_000_000_000n === 0n) return `${n / 1_000_000_000n} billion`;
  if (n % 1_000_000n === 0n) return `${n / 1_000_000n} million`;
  return supplyText();
}

/** Progress ratio (0..1) as a number, for rings and bars. */
export function progress(num: bigint | string, den: bigint | string): number {
  const n = typeof num === "string" ? BigInt(num) : num;
  const d = typeof den === "string" ? BigInt(den) : den;
  if (d <= 0n) return 0;
  const p = Number((n < 0n ? 0n : n) * PPM / d) / 1e6;
  return Math.max(0, Math.min(1, p));
}

export { LAMPORTS_PER_SOL };
