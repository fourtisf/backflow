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
  webpack: (config) => {
    // Optional native deps pulled in by Solana libraries; not needed in the browser.
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false };
    config.externals = [...(config.externals || []), "pino-pretty", "encoding"];
    return config;
  },
};

export default nextConfig;
