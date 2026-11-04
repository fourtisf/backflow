# Decisions and verification log

Running log of choices made while building Backflow, and of facts checked against Raydium's SDK, IDL or chain. Newest entries at the bottom of each section.

Sources used for verification (Milestone 1):

| Source | Version |
|---|---|
| `@raydium-io/raydium-sdk-v2` (npm and GitHub `raydium-io/raydium-sdk-V2`) | `0.2.81-alpha`, commit `f3fa7cbf` (2026-11-03). The npm tarball's `launchpad`, `cpmm` and `programId.ts` are byte-identical to the repo. |
| `raydium-io/raydium-sdk-V2-demo` | commit `63621ea9` (2026-10-26), pins SDK 0.2.75; the launchpad layout, PDA and instruction files are unchanged between 0.2.75 and 0.2.81 |
| `raydium-io/raydium-idl` (`raydium_launchpad.json`) | 2026-05-18. Older than the SDK: it lacks the newest PlatformConfig fields |
| `raydium-io/raydium-cpi` | 2026-07-20 |
| On-chain accounts | **Not read yet.** This build environment's network policy blocks every Solana RPC host and Raydium's APIs (HTTP 403). Every "needs RPC" item below is checked by `pnpm platform:show` / `pnpm platform:create` (dry run) on a machine with RPC access. |

---

## Decisions

### D-001 Open decisions (SPEC §14): defaults taken

| Decision | Choice | Where it lives |
|---|---|---|
| Brand and domain | "Backflow", `backflow.example` placeholder | `config/app.json` → `BRAND` in `packages/core` |
| Payout interval | 300 s. UI copy reads config ("every 5 minutes") | `config/fees.json` `payout.intervalSec` |
| Minimum payout | $0.50, rolls over | `config/fees.json` `payout.minPayoutUsd` |
| Buyback threshold | 1 SOL per buyback, max 1% impact, 20 s spacing | `config/fees.json` `buyback` |
| Post-graduation coin-token harvest | 100% to holders, never sold | `config/fees.json` `graduation.postGradHarvest` |
| Post-graduation SOL harvest | 2/3 buyback, 1/3 platform | same |
| Duplicate tickers | Blocked on Backflow (case-insensitive) | `tickerSlot` unique column (D-008), `/tickers/:t/available` |
| Vanity `…back` mints | Off for v1 | n/a (the mock data uses `…back` addresses for look only) |
| Creator's own wallet earns holder rewards | Yes, like any holder | rewards engine (Milestone 6) |

### D-002 Program IDs per cluster

Verified in the SDK (`src/common/programId.ts`) and cross-checked with `raydium-cpi` `declare_id!`. Global config, auth and lock-auth PDAs were re-derived from their seeds and match. Stored once in `packages/core/src/chain.ts`.

| | Mainnet | Devnet |
|---|---|---|
| LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6` |
| GlobalConfig (wSOL, curve 0, index 0) | `6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX` | `7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt` |
| CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` |
| Burn & Earn (one program for CLMM and CPMM locks) | `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE` | `DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX` |

Gotcha: every SDK launchpad method defaults `programId` to the **mainnet** program whatever `cluster` says, and `createLaunchpad` defaults `platformId` to Raydium's own mainnet platform. Our code always passes both explicitly.

### D-003 Fee math follows LaunchLab's rounding, not the spec's per-component formula

SPEC §6.3 says "recompute with the program's rounding". The SDK (`curve/curve.ts` `calculateFee` + `splitFee`) does this:

```
total    = ceil(quote × (protocol + platform + share + creator) / 1e6)   // one combined rate
platform = floor(total × platformRate / totalRate)
creator  = floor(total × creatorRate  / totalRate)
share    = floor(total × shareRate    / totalRate)
protocol = total − platform − creator − share                           // protocol gets the dust
```

Fees are always in SOL (quote): taken from the SOL in on buys and from the gross SOL out on sells. `packages/core` `tradeFees()` implements exactly this, with property tests. For a 1 SOL trade the numbers match the SPEC's worked example (0.0025 / 0.00675 / 0.00175, total 0.011). For small trades the platform fee can be 1 lamport lower than `ceil(q × 0.675%)`; the indexer will prefer the exact `platform_fee` from the program's `TradeEvent` (D-014) and only fall back to this.

The off-chain holders/platform split is unchanged: `holders = floor(platformFee × 2 / 3)`, `platform = platformFee − holders`.

### D-004 Creating the Platform PDA

`pnpm platform:create` (in `scripts/`) builds the SDK's raw `createPlatformConfig` instruction (discriminator = sha256("global:create_platform_config")[:8]) and sends it with web3.js. It does not use `Raydium.load()`, so it needs no Raydium HTTP API. It is a dry run by default (checks plus simulation) and only sends with `--send`. It is idempotent: if the PDA exists it prints and compares it.

Parameters, all from `config/fees.json` via `packages/core`:

| Field | Value |
|---|---|
| `feeRate` | 6750 (0.675%) |
| `creatorFeeRate` | 1750 (0.175%) |
| `migrateCpLockNftScale` | 1,000,000 / 0 / 0 |
| `platformClaimFeeWallet` | platform fee wallet |
| `platformLockNftWallet` | platform fee wallet by default. The SDK's `harvestLockLp` derives the NFT token account from the **fee payer**, so the Fee Key owner must also pay the harvest fee. It must be a hot key the harvest worker holds. |
| `platformVestingWallet` | `PublicKey.default` (no platform vesting) |
| `transferFeeExtensionAuth` | platform admin (only matters for Token-2022 launches, which we do not use) |
| `cpConfigId` | `CP_CONFIG_ID` if set, else the enabled CPMM AmmConfig whose trade fee is closest to 1% (read from chain) |
| `name` / `web` / `img` | brand name, `PUBLIC_SITE_URL`, `PUBLIC_SITE_URL/icon.svg` |

Before sending it reads the GlobalConfig and refuses to continue if the live protocol fee is not 0.25% (SPEC §2.1: the owner decides), unless run with `--accept-protocol-fee`. It also checks our curve against the config's floors.

Things that cannot be set at creation: `platformCpCreator`, `restrictGlobalConfig`, `restrictCurveParam` and `curveRuleManager`. These are only set with `updatePlatformConfig`. Updates are limited to **one per Solana epoch**. `creatorFeeRate` can only change through the `updateAll` variant.

**Status: not created yet.** This environment cannot reach any Solana RPC. Run it from a machine with devnet access (see the Milestone 1 report).

### D-005 `platformCpCreator` stays unset

IDL: if `platform_cp_creator` is set, it becomes the migrated CPMM pool's creator, and with it the right to claim CPMM creator fees. SPEC §2.2 wants CPMM creator fees to go to the original creator, so we leave it unset and the token creator stays the pool creator. What "unset" means on chain (`Pubkey::default`) still needs RPC or program source to confirm.

### D-006 Launch transaction: don't rely on `createLaunchpad` as-is (affects Milestone 2)

- `launchpad.createLaunchpad()` always calls `https://launch-mint-v1.raydium.io/main/configs` (devnet: `launch-mint-v1-devnet…`), even when every curve parameter is passed. The servers must be able to reach it, or we build the instructions ourselves (`initializeV2` + `buy` builders are exported).
- The SDK may split create and first buy into several transactions (`versionSizeCheckBuild`), and splits them deliberately on devnet. SPEC §4 requires the first buy in the **same** transaction. Milestone 2 will build one transaction (init + buy, V0 + lookup table if needed) and fail loudly if it does not fit.
- The creator account is not a signer of `initializeV2`, but the user's wallet signs anyway as payer. The creator fee vault is keyed by the creator wallet.
- Base decimals must be 6 (SDK `Curve.checkParam`), which matches `config/fees.json`. SPL Token is used unless `transferFeeExtensionParams` is passed. We never pass it.
- `migrateType: "cpmm"` must be passed explicitly. The SDK and protocol also accept `"amm"`; see D-011.

### D-007 Creator fees are per creator, not per coin (affects Milestone 8)

The creator fee vault PDA is `[creator, quoteMint]` under the LaunchLab program, with no pool or platform in the seeds. One vault collects all of a creator's LaunchLab fees, across coins and across platforms. `claimCreatorFee` empties the whole vault. The Rewards "Your launches" section therefore needs one claimable total per creator, with per-coin earned amounts as information only. The SDK method is `launchpad.claimCreatorFee` (batch: `claimMultipleCreatorFee`). `collectCreatorFees` is the **CPMM** post-graduation method.

### D-008 Prisma schema changes from the draft

- `Trade` key is `(signature, eventIndex)`: one transaction can hold several trades, such as launch plus first buy or bundled buys. `FeeAccrual` references it.
- `Coin.tickerKey @unique` became `tickerKey` plus `tickerSlot String? @unique`. The coin that owns a ticker sets `tickerSlot = tickerKey`; duplicates indexed from other frontends keep `tickerSlot = null` and `hidden = true` (SPEC §4). This is Prisma-native, with no raw partial index.
- New `Coin` columns:
  - `platformConfig`, `avatarSeed`, `decimals`, `supply`, `graduationTargetLamports`;
  - curve reserves (`virtualBase`/`virtualQuote`/`realBase`/`realQuote`);
  - `rewardDust`, `forfeitPool`;
  - per-coin pause switches (`buybacksPaused`, `payoutsPaused`), `hiddenReason`.
- `Buyback`:
  - new `round`, `chunk` (impact-cap chunks) and `venue`;
  - quote and slippage bound (`quotedTokens`, `minTokensOut`), `dustCarried`;
  - retry bookkeeping (`attempts`, `error`, `sentAt`).
- `RewardCredit` stores the TWAB `weight` used, so every credit can be reproduced (CLAUDE.md rule 5).
- `Payout` gains `status` and `rolledOverAmount`. `PayoutItem` gains `batch`, `attempts` and `error`.
- `VaultClaim` records the follow-up transfers to the buyback wallet and treasury, and the mismatch.
- `Harvest` records the 2/3 and 1/3 split.
- `ExcludedAccount` key is `(address, scope)`, where scope is `"global"` or a mint.
- New `Setting` table for global switches (admin).
- Prisma stays on 6.19.3, as CLAUDE.md asks.

### D-009 Milestone 1 data comes from a mock provider behind the real API

The API (Fastify) serves every SPEC §6.2 route and `WS /live` from a `DataProvider` interface. Milestone 1 ships `MockProvider`, a server-side port of the prototype's simulation (seeded, amounts as bigint base units). Milestone 3 adds the Postgres-backed provider, and the web app does not change. `/stats` reports `mode: "mock"`. The UI then shows a "Simulated data" tag in the live strip and says so in the footer.

What is real in Milestone 1: wallet connection and the connected wallet's devnet SOL balance (read from the RPC in the browser).

### D-010 Styling: the prototype CSS is ported verbatim

`apps/web/src/app/globals.css` is the prototype's stylesheet unchanged, apart from one `align-items:end` → `flex-end` that autoprefixer flagged; it renders the same. Components use the same class names. This reproduces the design tokens exactly without translating them to Tailwind; additions live in `app.css`. Fonts load from Google Fonts as in the prototype.

### D-011 Migrate type: CPMM by our choice, not by protocol rule

The SDK and IDL accept both `migrate_type` 0 (AMM v4) and 1 (CPMM). The protocol forces CPMM only for Token-2022 mints or when a platform enforces it with curve rules. Backflow needs CPMM anyway: the locked-LP Fee Key, `cpConfigId` and CPMM creator fees only exist on that path. Milestone 2 passes `"cpmm"`. We can also set `restrictCurveParam` with a PlatformCurveRule so launches from other frontends under our PDA must use CPMM too (to decide in Milestone 8).

### D-012 Wallets

The explicit adapters are Phantom and Solflare. Backpack, and any other Wallet Standard wallet, is detected automatically; Backpack no longer ships a legacy adapter. The connect dialog is a custom modal in the prototype's style. Wallets that are not installed get an "Install" link.

### D-013 Mainnet guard in scripts

Every script that can send a transaction refuses `SOLANA_CLUSTER=mainnet-beta` unless the owner sets `BACKFLOW_MAINNET_APPROVED=owner-approved-mainnet` for that one command. Read-only `platform:show` may read mainnet.

### D-014 Trade events (affects Milestone 3)

The SDK decodes no events. The IDL defines `TradeEvent` (discriminator `[189,219,127,211,78,230,97,238]`). Its fields include exact `protocol_fee`, `platform_fee`, `creator_fee`, `share_fee`, `amount_in`/`amount_out`, reserves before and after, direction and pool status. Trade instructions carry `event_authority` and `program`, the Anchor `#[event_cpi]` pattern, so events should be in self-CPI inner-instruction data (`e445a52e51cb9a1d` + discriminator + body) rather than "Program data:" logs. The indexer will decode inner instructions. Confirming this on a live transaction, and that the layout is unchanged since the May 2026 IDL, needs RPC.

### D-015 Fee Key harvest (affects Milestone 7)

The method is `raydium.cpmm.harvestLockLp({ poolInfo, nftMint, lpFeeAmount, programId, authProgram, cpmmProgram })`. On devnet, pass all three program overrides; the demo omits `cpmmProgram` and the builder silently falls back to mainnet. The SDK cannot compute `lpFeeAmount`: read it from chain or from Raydium's API.

---

## VERIFY checklist (`docs/RAYDIUM_LAUNCHLAB.md`)

✅ verified from SDK, IDL or demo source · ⏳ needs RPC (run `pnpm platform:show`) · ⚠️ spec claim not supported by the sources

- [x] ✅ **LaunchLab, CPMM and Burn & Earn program IDs, mainnet and devnet.** Evidence: D-002.
- [ ] ⏳ **`GlobalConfig` for wSOL constant-product.**
  - ✅ Address derived (D-002). Layout: `tradeFeeRate`, `migrateFee`, `maxShareFeeRate`, `minSupplyA`, `maxLockRate`, `minSellRateA`, `minMigrateRateA`, `minFundRaisingB` (SDK `layout.ts:5-26`), all rates in 1e-6.
  - ⏳ Live values, including whether `trade_fee_rate` = 2500 (0.25%), are printed by `platform:show` and checked by `platform:create`.
  - Note: the SDK layout does not decode `requires_platform_auth` (byte 243); our decoder reads it.
- [x] ✅ **`PlatformConfig` field names, units and create/update instructions.**
  - All rates are in 1/1,000,000 (`FEE_RATE_DENOMINATOR_VALUE`), so 6750 = 0.675%. Fields are in SDK `layout.ts:106-136`.
  - Create: `createPlatformConfig`. Update: `updatePlatformConfig`, 15 variants (D-004).
  - ⚠️ **Caps:** no cap on `feeRate` or `creatorFeeRate` exists in the SDK or IDL, only "total fee ≤ 100%". The documented 1% / 0.5% caps can't be confirmed; an on-chain cap may exist (test: simulate with `feeRate` 10001). Our 0.675% and 0.175% are under both anyway.
- [x] ✅ **Creator fee.**
  - Vault PDA is `[creator, quoteMint]`, per creator, not per pool (D-007).
  - Claim is `launchpad.claimCreatorFee` / `claimMultipleCreatorFee`; instruction `claim_creator_fee`.
  - ⏳ Rate cap: see above.
- [x] ✅ **Platform fee vault.**
  - PDA `[platformConfig, quoteMint]`, no string prefix.
  - Vault authority PDA `["platform_fee_vault_auth_seed"]`.
  - Claim: SDK method **`launchpad.claimVaultPlatformFee`** (the doc said `ClaimPlatformFeeFromVault`, which is the instruction builder and demo file name). Instruction `claim_platform_fee_from_vault`.
  - The SDK sends to the SDK owner's token account, so the reconcile worker must run it as the claim-fee wallet.
- [ ] ⏳ **Trade events expose exact fees.**
  - ✅ The IDL `TradeEvent` has exact `protocol_fee`, `platform_fee`, `creator_fee`, `share_fee` (D-014).
  - ⏳ Emission path and current layout need a live transaction.
- [ ] ⏳ **Curve limits for 1B supply, 80% sold, 85 SOL target.**
  - ✅ The SDK checks decimals = 6 and the floors (`Curve.checkParam`).
  - ✅ The SDK defaults are 1B supply, 793.1M sold, 85 SOL.
  - ⏳ Our 800M sold against the live `min_base_sell_rate` / `min_base_migrate_rate` is checked by `platform:create` (prints ok/FAIL per floor).
- [ ] ⏳ **Mint and freeze authority revoked on initialize.** The SDK has no revoke instruction; the program creates the mint. Inspect any LaunchLab mint on chain.
- [ ] ⏳ **CPMM `AmmConfig` fee tiers and split; pick `cp_config_id`.**
  - ✅ Layout: `tradeFeeRate`, plus `protocolFeeRate` and `fundFeeRate` as fractions of the trade fee; the LP keeps the remainder. `creatorFeeRate` is charged on top.
  - ⏳ Live tiers: `platform:create` lists them all and picks the one closest to 1%.
- [x] ✅ **Fee Key harvest flow.** `cpmm.harvestLockLp` / `harvestMultiLockLp`, instruction `collectCpFee`; gotchas in D-015.
- [x] ✅ **`platformCpCreator` behavior.** If set, it becomes the CPMM pool creator and takes the CPMM creator fees. We leave it unset (D-005). ⏳ The "unset" value still needs confirming.
- [x] ✅ **Devnet availability.** LaunchLab, CPMM and the lock program have devnet deployments (D-002). ⏳ That they are live and that the devnet GlobalConfig exists: `platform:show`.

### Spec claims that the sources contradict or do not support

| Claim (SPEC / RAYDIUM_LAUNCHLAB.md) | Finding |
|---|---|
| "Since the 2026-08-17 upgrade, `creatorScale` must be 0 (the program asserts this)" | ⚠️ No such check in the SDK or IDL. The official demo still uses `creatorScale` 500,000. It may be an on-chain rule newer than the sources; we use 0, which is valid under either reading. |
| "`migrate_type = 1` (CPMM) mandatory for new launches" | ⚠️ Not a protocol rule (D-011). We use CPMM by choice. |
| Platform fee capped at 1%, creator fee capped at 0.5% | ⚠️ Not found in the SDK or IDL. Unverified. |
| Creator claim helper `collectCreatorFees` | ⚠️ That is the CPMM method. LaunchLab's is `claimCreatorFee`. |
| Fee rounding "recompute with the program's rounding" | Now specified: D-003. |
| Platform PDA seeds `["platform_config", platform_admin]` | ✅ Correct. |
| Pool status 0 → 1 → 2 | ✅ 0 = Fund (curve trading), 1 = Migrate (waiting for migration), 2 = Trade (migrated). |
