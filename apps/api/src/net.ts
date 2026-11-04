/**
 * Client identity for rate limits and connection caps (audit H2).
 *
 * The API listens on 127.0.0.1 behind Nginx. Fastify trusts X-Forwarded-For
 * only from the proxy addresses in TRUST_PROXY (default 127.0.0.1) and takes
 * the right-most untrusted entry, and Nginx overwrites the header with
 * $remote_addr, so a client can't pick its own rate-limit bucket. IPv6
 * clients are grouped by /64, because one host usually controls a whole /64.
 */
import { createHash, randomBytes } from "node:crypto";

/** TRUST_PROXY: a comma-separated list of proxy IPs/CIDRs, a hop count, or "false". Never plain "true". */
export function parseTrustProxy(v: string | undefined): string | number | boolean {
  const s = (v ?? "").trim();
  if (!s) return "127.0.0.1";
  if (s === "false" || s === "0") return false;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "true") throw new Error("TRUST_PROXY=true would trust any X-Forwarded-For header. Set the proxy address instead (default 127.0.0.1).");
  return s;
}

function expandV6(ip: string): number[] | null {
  const [head = "", tail] = ip.split("::");
  const parts = (s: string) => (s ? s.split(":") : []);
  const toNums = (xs: string[]) =>
    xs.flatMap((x) => {
      if (x.includes(".")) {
        const o = x.split(".").map(Number);
        return o.length === 4 && o.every((n) => n >= 0 && n <= 255) ? [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!] : [NaN];
      }
      return [parseInt(x, 16)];
    });
  const h = toNums(parts(head));
  const t = tail === undefined ? null : toNums(parts(tail));
  const all = t === null ? h : [...h, ...new Array<number>(Math.max(0, 8 - h.length - t.length)).fill(0), ...t];
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/** Rate-limit key for an address: IPv4 as is, IPv6 by its /64 prefix. */
export function ipKey(ip: string | undefined): string {
  const raw = (ip ?? "").split("%")[0]!.trim();
  if (!raw.includes(":")) return raw || "unknown";
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1]!;
  const n = expandV6(raw);
  if (!n) return raw.toLowerCase();
  return `${n.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * An anonymous, per-day reporter id: sha256(ip key + daily salt), truncated. The salt is random,
 * lives only in memory and changes every UTC day, so ids can't be linked across days or reversed.
 */
export function makeReporterId() {
  let day = "";
  let salt = Buffer.alloc(0);
  return (ip: string | undefined, now = new Date()): string => {
    const d = now.toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      salt = randomBytes(16);
    }
    return "r:" + createHash("sha256").update(salt).update(ipKey(ip)).digest("hex").slice(0, 24);
  };
}
