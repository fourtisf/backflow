import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Read the repo-root .env so NEXT_PUBLIC_* values live in one place.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv) && typeof process.loadEnvFile === "function") process.loadEnvFile(rootEnv);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@backflow/core"],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  images: { unoptimized: true },
  async headers() {
    // Wallet extensions inject their own scripts (not affected by CSP). Next needs inline scripts for hydration.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: wss: ws://localhost:4000 http://localhost:4000",
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
