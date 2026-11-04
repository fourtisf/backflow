# CLAUDE.md — Backflow project rules

## What this is
Backflow is a Solana memecoin launchpad built on Raydium LaunchLab. A 1.1% fee on every bonding-curve trade is split: Raydium protocol 0.25%, holders 0.45% (used to buy the coin back and distribute it to holders), platform 0.225%, creator 0.175%. Full spec: `docs/SPEC.md`.

## Stack (use exactly this unless the spec says otherwise)
- Monorepo with pnpm workspaces:
  - `apps/web`: Next.js 14 (App Router), TypeScript, React, Tailwind is allowed but must reproduce the prototype's design tokens exactly. Solana wallet adapter (Phantom, Solflare, Backpack).
  - `apps/api`: Fastify (TypeScript). REST plus a WebSocket endpoint for live events.
  - `apps/workers`: TypeScript workers. One process per worker: `indexer`, `buyback`, `payout`, `harvest`, `reconcile`.
  - `packages/core`: shared fee math, types, constants loaded from `config/fees.json`, Raydium helpers.
  - `packages/db`: Prisma client and migrations. Pin Prisma 6.x, because the draft schema uses `datasource.url`. If you choose Prisma 7, move the URL to `prisma.config.ts`.
- PostgreSQL via Prisma, Redis (BullMQ queues plus pub/sub for live updates).
- Solana: `@solana/web3.js`, `@solana/spl-token`, `@raydium-io/raydium-sdk-v2`. Helius RPC and webhooks (or Geyser) for indexing.
- IPFS for token metadata and images (Pinata).
- Production: a single Hostinger VPS, PM2 for processes, Nginx reverse proxy with TLS. Provide `ecosystem.config.js` and an Nginx config sample.

## Hard rules
1. Never commit secrets. Keypairs are loaded from paths or environment variables at runtime, and the repo ships only `.env.example`.
2. No mainnet transactions and no mainnet deploys without explicit approval from the owner in chat.
3. All on-chain amounts are integers in base units (lamports, token base units) using `bigint`. Only the UI formats them into decimals.
4. Fee constants live only in `config/fees.json` and are read through `packages/core`. Nothing else hard-codes 1.1, 0.45, 0.225, 0.175, or 0.25.
5. Every buyback and every payout must be reproducible from the database plus chain data. Write rows before and after each transaction (status `pending` → `sent` → `confirmed` or `failed`), and make each job idempotent so a retry never double-spends.
6. Hot wallets hold only what they need. Use separate keys for the buyback signer, the distributor, and the platform fee claimer. Platform admin authority goes to a Squads multisig before mainnet.
7. Facts marked **VERIFY** in `docs/RAYDIUM_LAUNCHLAB.md` must be checked against the SDK, IDL, or chain before being relied on in code.
8. Accessibility and responsiveness: everything works at 390px wide, keyboard focus is visible, and `prefers-reduced-motion` is respected (the hero canvas must render a static frame).
9. UI copy is in English, sentence case, plain words. Match the prototype's copy unless real data requires a change.

## Commands to provide
`pnpm dev` (all apps), `pnpm test`, `pnpm db:migrate`, `pnpm workers:dev`, and a `pnpm sim` script that simulates trades on devnet so buybacks and payouts can be watched end to end.

## Reporting
After each milestone, report: what was built, how to run it, test results, and anything in the spec that turned out to be wrong.
