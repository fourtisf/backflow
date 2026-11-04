/**
 * Fetching untrusted metadata URLs (coin metadata from any frontend) without
 * letting a hostile server stall or crash the indexer, or reach internal hosts:
 * https only, every resolved address checked against private ranges (at connect
 * time, so DNS rebinding can't slip past), one total deadline that covers the
 * body, a byte cap, and no redirects.
 */
import { isPrivateIp } from "@backflow/core";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import type { LookupFunction } from "node:net";

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
}

export const METADATA_LIMITS: FetchLimits = { timeoutMs: 6_000, maxBytes: 64 * 1024 };

type Resolver = (host: string, cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (host, cb) => dnsLookup(host, { all: true }, cb);

/** A net.lookup replacement that refuses hosts resolving to any private/loopback/link-local address. */
export function guardedLookup(resolve: Resolver = systemResolver): LookupFunction {
  return ((host: string, opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(host, (err, addrs) => {
      if (err) return cb(err, "", 0);
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
        const e = new Error(`refusing to connect to ${host}: private address`) as NodeJS.ErrnoException;
        e.code = "EPRIVATE";
        return cb(e, "", 0);
      }
      const all = (opts as { all?: boolean } | undefined)?.all;
      if (all) return cb(null, addrs);
      return cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  }) as LookupFunction;
}

export class FetchRefused extends Error {}

/** GET an https URL and parse JSON within the limits. Throws FetchRefused (or a network error) on any violation. */
export function fetchJsonLimited(url: string, limits: FetchLimits = METADATA_LIMITS, lookup: LookupFunction = guardedLookup()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new FetchRefused("bad url"));
    }
    if (u.protocol !== "https:") return reject(new FetchRefused("https only"));
    let done = false;
    const finish = (err: Error | null, v?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(v);
    };
    const req = request(u, { method: "GET", lookup, headers: { accept: "application/json", "user-agent": "backflow-indexer" } }, (res) => {
      if (res.statusCode !== 200) return finish(new FetchRefused(`status ${res.statusCode}`)); // includes 3xx: redirects are not followed
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > limits.maxBytes) return finish(new FetchRefused("too large"));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limits.maxBytes) return finish(new FetchRefused("too large"));
        chunks.push(c);
      });
      res.on("end", () => {
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish(new FetchRefused("not json"));
        }
      });
      res.on("error", (e) => finish(e));
    });
    const timer = setTimeout(() => finish(new FetchRefused("timeout")), limits.timeoutMs);
    req.on("error", (e) => finish(e));
    req.end();
  });
}
