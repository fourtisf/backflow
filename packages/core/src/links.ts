/**
 * Sanitizers for untrusted coin metadata. Used by the API (metadata we pin),
 * the indexer (metadata of coins launched from any frontend) and the web
 * (again at render time). Everything here is pure and has no I/O.
 */

import { BRAND } from "./brand";

export const LINK_HOSTS = {
  x: /(^|\.)(x|twitter)\.com$/i,
  telegram: /(^|\.)(t\.me|telegram\.me)$/i,
} as const;

export const META_LIMITS = { name: 64, symbol: 16, description: 280, link: 200, image: 512 } as const;

/** https only, optional host rule, max 200 chars. Bare hosts get https:// prepended. Returns null for anything else. */
export function cleanLink(v: unknown, host: RegExp | null = null): string | null {
  if (typeof v !== "string" || !v.trim() || v.length > 2048) return null;
  let s = v.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) return null; // javascript:, data:, ftp: …
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (host && !host.test(u.hostname)) return null;
    const out = u.toString();
    return out.length <= META_LIMITS.link ? out : null;
  } catch {
    return null;
  }
}

/** Render-time guard for an href that came from data: https only, or undefined. */
export function safeHref(v: unknown, kind: "x" | "telegram" | "website"): string | undefined {
  return cleanLink(v, kind === "website" ? null : LINK_HOSTS[kind]) ?? undefined;
}

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

/** Extracts an IPFS CID (plus optional path) from ipfs://, /ipfs/ gateway URLs or a bare CID. */
export function ipfsPath(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const s = uri.trim();
  let rest: string | null = null;
  if (/^ipfs:\/\//i.test(s)) rest = s.replace(/^ipfs:\/\/(ipfs\/)?/i, "");
  else if (CID.test(s.split("/")[0] ?? "")) rest = s;
  else {
    try {
      const u = new URL(s);
      if (u.protocol !== "https:") return null;
      const m = u.pathname.match(/^\/ipfs\/(.+)$/);
      if (m) rest = m[1]!;
      else {
        const sub = u.hostname.match(/^([a-z0-9]{46,})\.ipfs\./i); // subdomain gateways
        if (sub) rest = sub[1]! + u.pathname.replace(/\/$/, "");
      }
    } catch {
      return null;
    }
  }
  if (!rest) return null;
  const [cid, ...path] = rest.split("/");
  if (!cid || !CID.test(cid)) return null;
  const p = path.join("/");
  if (p && !/^[A-Za-z0-9._\-/]{1,200}$/.test(p)) return null;
  return p ? `${cid}/${p}` : cid;
}

/**
 * Coin images stored on our own server (D-048): exactly https://<our domain>/api/media/<sha256>.<image ext>.
 * Only that shape is trusted, so no other host or path can slip through.
 */
const OWN_MEDIA_IMAGE = new RegExp(`^https://(www\\.)?${BRAND.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/media/[0-9a-f]{64}\\.(png|jpg|gif|webp)$`);
export function ownMediaImage(uri: unknown): string | null {
  return typeof uri === "string" && OWN_MEDIA_IMAGE.test(uri.trim()) ? uri.trim() : null;
}

/**
 * Rewrites an IPFS image reference to our own gateway and keeps images on our own server; anything else is
 * dropped (the UI falls back to the generated avatar).
 */
export function gatewayImage(uri: unknown, gateway: string): string | null {
  const own = ownMediaImage(uri);
  if (own) return own;
  const p = ipfsPath(uri);
  if (!p) return null;
  const out = `${gateway.replace(/\/?$/, "/")}${p}`;
  return out.length <= META_LIMITS.image ? out : null;
}

export interface CleanMetadata {
  description: string | null;
  imageUri: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  // strip control, bidi-override and zero-width characters (look-alike names, audit)
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩\u200B-\u200F\u2060\uFEFF\u00AD]/g, "").trim();
  return s ? s.slice(0, max) : null;
};

/** Validates a token metadata JSON object (Metaplex-style) from an untrusted source. Never throws. */
export function cleanMetadata(raw: unknown, gateway: string): CleanMetadata {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const ext = o.extensions && typeof o.extensions === "object" ? (o.extensions as Record<string, unknown>) : {};
  return {
    description: str(o.description, META_LIMITS.description),
    imageUri: gatewayImage(o.image, gateway),
    website: cleanLink(o.website ?? ext.website, null),
    x: cleanLink(o.twitter ?? ext.twitter, LINK_HOSTS.x),
    telegram: cleanLink(o.telegram ?? ext.telegram, LINK_HOSTS.telegram),
  };
}

/** Name/symbol from an on-chain event: control chars stripped, length capped. */
export const cleanText = (v: unknown, max: number): string => str(v, max) ?? "";

/** True when a ticker is plain ASCII letters/digits (lookalike tickers from other frontends fail this). */
export const isPlainTicker = (t: string): boolean => /^[A-Za-z0-9]{1,10}$/.test(t);

/** Metadata URIs the indexer may fetch: https or ipfs only, no credentials, no IP-literal or local hosts. */
export function fetchableMetadataUri(uri: string, gateway: string): string | null {
  const p = ipfsPath(uri);
  if (p) return `${gateway.replace(/\/?$/, "/")}${p}`;
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (u.port && u.port !== "443") return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return null; // IP literals
    return u.toString();
  } catch {
    return null;
  }
}

/** Private, loopback, link-local and metadata ranges (checked on resolved addresses). */
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") || s.startsWith("ff");
}

/** Removes API keys from text that may be logged or sent in an alert (RPC URLs carry `api-key=`). */
export function redactSecrets(text: string): string {
  return text.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1…").replace(/(bot)\d+:[A-Za-z0-9_-]{20,}/g, "$1…");
}
