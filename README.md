# Backflow

A Solana memecoin launchpad on Raydium LaunchLab. Every trade pays 1.1%, and 0.45% of every trade buys the coin back on the open market and pays those tokens to the people holding it.

- Product and technical spec: [`docs/SPEC.md`](docs/SPEC.md)
- Project rules: [`CLAUDE.md`](CLAUDE.md)
- LaunchLab integration notes: [`docs/RAYDIUM_LAUNCHLAB.md`](docs/RAYDIUM_LAUNCHLAB.md)
- Decisions and VERIFY evidence: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Keys and authorities: [`docs/AUTHORITIES.md`](docs/AUTHORITIES.md)
- Approved UI prototype: [`prototype/backflow.html`](prototype/backflow.html)

Fee constants live only in [`config/fees.json`](config/fees.json) and are read through `packages/core`.

## Layout

```
apps/web        Next.js 14 (App Router): every page from the prototype, wallet connect
apps/api        Fastify REST + WS /live (Milestone 1: mock data provider)
apps/workers    indexer, buyback, payout, harvest, reconcile (one process each; skeletons for now)
packages/core   fee config, bigint money math, formatters, API types, Raydium addresses
packages/db     Prisma 6 schema, migrations, client
scripts         operator scripts: platform:create, platform:show, keys:new, sim
config          fees.json, app.json (brand), .env.example
deploy          Nginx sample (PM2 file: ecosystem.config.js at the root)
```

## Run it locally

Requirements: Node 20.12+ (22 recommended), pnpm 10, PostgreSQL 16, Redis 7 (Redis is needed from Milestone 3).

```bash
pnpm install
```

```bash
cp config/.env.example .env
```

Edit `.env`: at least `DATABASE_URL`. Then:

```bash
pnpm db:migrate
```

```bash
pnpm dev
```

- Web: http://localhost:3000
- API: http://localhost:4000 (try `/health`, `/coins`, `/stats`)

In Milestone 1 the API runs with `DATA_MODE=mock`: every number on the site is simulated, and the site says so ("Simulated data" in the live strip and in the footer). Wallet connection and your devnet SOL balance are real.

Other commands:

| Command | What it does |
|---|---|
| `pnpm test` | Unit and property tests (fee math, formatting, validation, API routes, mock simulation) |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm workers:dev` | Starts the five workers, each with a `/health` endpoint on ports 4101–4105 |
| `pnpm platform:create` | Creates our LaunchLab PlatformConfig on devnet. Dry run by default; add `-- --send` |
| `pnpm platform:show` | Prints the live GlobalConfig, our PlatformConfig and the CPMM fee tiers |
| `pnpm --filter @backflow/scripts keys:new -- --dir <dir>` | Generates hot-wallet keypairs outside the repo |
| `pnpm sim` | Devnet trade simulation (arrives with Milestone 4) |

## Create the Platform PDA on devnet

```bash
pnpm --filter @backflow/scripts keys:new -- --dir ~/.config/backflow/keys
```

Point `PLATFORM_ADMIN_KEYPAIR_PATH` and `PLATFORM_FEE_WALLET_KEYPAIR_PATH` in `.env` at the generated files, and set `RPC_URL` to a devnet RPC (or leave it as is to use the public devnet endpoint). Fund the admin with about 0.1 devnet SOL (or add `-- --airdrop`), then:

```bash
pnpm platform:create
```

```bash
pnpm platform:create -- --send
```

Copy the printed `PLATFORM_CONFIG_PUBKEY` and `CP_CONFIG_ID` into `.env`.

## Safety

- No mainnet transactions or deploys without the owner's explicit approval. Scripts refuse mainnet unless `BACKFLOW_MAINNET_APPROVED=owner-approved-mainnet` is set for that command.
- Never commit secrets. Keys are loaded from paths outside the repo; scripts refuse paths inside it.
- Backflow is not audited. Coins are speculative.
