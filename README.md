# Backflow

A Solana memecoin launchpad on Raydium LaunchLab. Every trade pays 1.1%, and 0.45% of every trade buys the coin back on the open market and pays those tokens to the people holding it.

- Product and technical spec: [`docs/SPEC.md`](docs/SPEC.md)
- Project rules: [`CLAUDE.md`](CLAUDE.md)
- LaunchLab integration notes: [`docs/RAYDIUM_LAUNCHLAB.md`](docs/RAYDIUM_LAUNCHLAB.md)
- Decisions and VERIFY evidence: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Keys and authorities: [`docs/AUTHORITIES.md`](docs/AUTHORITIES.md)
- Deploying: [`docs/DEPLOY.md`](docs/DEPLOY.md) · Security checklist: [`docs/SECURITY.md`](docs/SECURITY.md) · Mainnet runbook: [`docs/MAINNET.md`](docs/MAINNET.md)
- Approved UI prototype: [`prototype/backflow.html`](prototype/backflow.html)

Fee constants live only in [`config/fees.json`](config/fees.json) and are read through `packages/core`.

## Layout

```
apps/web        Next.js 14: every prototype page, wallet connect, launch/trade/claim flows, /admin
apps/api        Fastify REST + WS /live; DATA_MODE=mock (simulated) or live (Postgres + Redis + chain)
apps/workers    indexer, buyback, payout, harvest, reconcile (one process each, advisory-locked)
packages/core   fee config, bigint money math (curve, TWAB, payouts), formatters, API types
packages/chain  Raydium LaunchLab/CPMM builders, event parsing, send/confirm, prices
packages/db     Prisma 6 schema, migrations, client, DTO mappers
scripts         platform:create, platform:show, alt:create, keys:new, sim
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

With `DATA_MODE=mock` (the default) every number on the site is simulated, and the site says so ("Simulated data" in the live strip and footer); nothing can be sent on chain. With `DATA_MODE=live` the API serves the indexer's data and builds real transactions; that needs the platform created (below), Redis, and the workers running.

Other commands:

| Command | What it does |
|---|---|
| `pnpm test` | Unit, property and integration tests (needs local Postgres; see below) |
| `pnpm typecheck` / `pnpm lint` | TypeScript across the workspace / ESLint for the web app |
| `pnpm e2e` | Playwright smoke tests against a running mock stack (desktop and 390 px) |
| `pnpm workers:dev` | The five workers, each with `/health` on ports 4101–4105 (idle until `PLATFORM_CONFIG_PUBKEY` is set) |
| `pnpm platform:create` | Creates our LaunchLab PlatformConfig. Dry run by default; `-- --send` sends; `-- --squads <vault>` prints a Squads transaction (mainnet) |
| `pnpm platform:show` | Prints the live GlobalConfig, our PlatformConfig and the CPMM fee tiers |
| `pnpm platform:update -- --sync` | Brings the live PlatformConfig in line with `config/fees.json` (also `--fee-rate`, `--creator-fee`, `--cp-config`, `--claim-wallet`, `--lock-nft-wallet`, `--require-cpmm`). Dry run unless `--send`; `--squads` prints a Squads transaction |
| `pnpm alt:create` | Creates the shared address lookup table, frozen so no key can close it (`-- --send`; `-- --no-freeze` keeps it extendable) |
| `pnpm --filter @backflow/scripts vanity:grind -- --count 20` | Grinds "…back" mint keypairs offline and stores them encrypted with `VANITY_KEY` (used when `VANITY_ENABLED=1`) |
| `pnpm --filter @backflow/scripts keys:new -- --dir <dir>` | Generates hot-wallet keypairs outside the repo |
| `pnpm sim -- --launch` or `-- --mint <mint>` | Random devnet buys and sells to watch buybacks and payouts end to end |

Tests use two local databases, `backflow_test` (workers) and `backflow_test_api` (API). Create them once:

```bash
sudo -u postgres psql -c "CREATE DATABASE backflow_test OWNER backflow;" -c "CREATE DATABASE backflow_test_api OWNER backflow;"
```

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
