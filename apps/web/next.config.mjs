import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Read the repo-root .env so NEXT_PUBLIC_* values live in one place.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv) && typeof process.loadEnvFile === "function") process.loadEnvFile(rootEnv);

/** Origin of an absolute URL, or null for relative/empty/invalid values. */
function originOf(u) {
  try {
    return u && /^[a-z]+:\/\//i.test(u) ? new URL(u).origin : null;
  } catch {
    return null;
  }
}

/** http(s) origin -> the matching ws(s) origin. */
const wsOrigin = (o) => (o ? o.replace(/^http/, "ws") : null);

/**
 * connect-src lists only what the app talks to (audit L1): our API and its WebSocket, the Solana RPC,
 * and Plausible when enabled. localhost entries only in development.
 */
function connectSources() {
  const dev = process.env.NODE_ENV === "development";
  // same default as src/lib/api.ts, so the policy always allows the API the app actually calls
  const api = originOf(process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000");
  const ws = originOf(process.env.NEXT_PUBLIC_WS_URL) ?? wsOrigin(api);
  const rpc = originOf(process.env.NEXT_PUBLIC_RPC_URL) ?? (process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
  const out = new Set(["'self'", api, ws, rpc, wsOrigin(rpc)]);
  if (process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN) out.add("https://plausible.io");
  if (dev) for (const s of ["http://localhost:4000", "ws://localhost:4000", "http://127.0.0.1:4000", "ws://127.0.0.1:4000"]) out.add(s);
  return [...out].filter(Boolean).join(" ");
}

/** img-src: our own files, data:/blob: previews, and the one IPFS gateway coin images are rewritten to. */
function imageSources() {
  const gw = originOf(process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs/");
  return ["'self'", "data:", "blob:", gw].filter(Boolean).join(" ");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The live server builds into a separate folder and swaps it in, so the running site never serves a
  // half-written build (deploy/update-live.sh). `next start` always reads the default `.next`.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // @backflow/chain is imported only as "@backflow/chain/verify" (pure, browser-safe).
  transpilePackages: ["@backflow/core", "@backflow/chain"],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  images: { unoptimized: true },
  async headers() {
    // Wallet extensions inject their own scripts (not affected by CSP). Next 14 needs inline scripts for
    // hydration and we don't run nonce middleware, so script-src keeps 'unsafe-inline' (see docs/SECURITY.md).
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'" + (process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN ? " https://plausible.io" : "") + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      `img-src ${imageSources()}`,
      `connect-src ${connectSources()}`,
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  webpack: (config) => {
    // Optional native deps pulled in by Solana libraries; not needed in the browser.
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false };
    config.externals = [...(config.externals || []), "pino-pretty", "encoding"];
    return config;
  },
};

export default nextConfig;
