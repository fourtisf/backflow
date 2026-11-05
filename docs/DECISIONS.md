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

### D-016 Job state lives in Postgres; Redis is pub/sub only (no BullMQ yet)

CLAUDE.md lists BullMQ for queues. Every money-moving job is already a row with an idempotency key and a pending → sent → confirmed/failed state machine (rule 5), and each worker runs as one process holding a Postgres advisory lock. A BullMQ queue would be a second state store that can disagree with the database. Redis carries live events (workers → API → `WS /live`). BullMQ can be added later for visibility without changing correctness.

### D-017 Buybacks deliver tokens straight to the distributor (VERIFY on devnet)

LaunchLab's `user_base_token` is only constrained by mint (raydium-cpi `Swap` context), so the buyback wallet pays SOL and the coins land in the distributor's token account in the same transaction. That is one transaction fewer, and the buyback wallet never holds coins. If devnet shows a stricter check, `redirectBaseTo` in `apps/workers/src/chain.ts` is the one place to change.

### D-018 The API builds transactions for wallets

SPEC §4 says the web app builds the launch transaction. We build it in the API instead: the Raydium SDK stays out of the browser bundle, the ticker is reserved atomically (`LaunchIntent`, 2 minutes), and the same builders are used by workers and `pnpm sim`. The API generates the mint keypair, signs with it and discards it; the user's wallet signs as payer and creator. The API never signs for users.

### D-019 One TWAB window per buyback round

Rounds are split into chunks at least 20 s apart (impact cap). If each chunk had its own window, a wallet buying between chunks would get a large share of a 20-second window. All chunks of a round therefore share the window that starts where the previous round ended. `lastDistributionAt` only moves when a round is fully credited. There is a test for this ("the 1-second sniper earns less than a small long-time holder").

### D-020 Harvested coin tokens join the next distribution

SPEC §2.2 sends 100% of harvested coin tokens to holders. They are added to `Coin.extraRewardTokens` and distributed with the next buyback's TWAB credits, together with carried dust and forfeitures, so every token goes out through the same reproducible path.

### D-021 Forfeiture window resets at every payout of the coin

`decreasedSincePayout` is cleared for all holders of a coin when that coin's payout round runs, whether or not they were paid. A rollover below the minimum doesn't extend the window. Forfeited tokens go to `Coin.forfeitPool` and into the next distribution.

### D-022 Indexing by polling signatures

The indexer polls `getSignaturesForAddress` for our PlatformConfig (every launch, trade and migration references it) and for each coin's mint. This is restart-safe: there is one cursor per stream, written in the same DB transaction as the effects.

- **Backlogs** are paged back to the cursor and processed oldest first (`collectSignatures`). A backlog larger than one RPC page is worked through, not skipped (audit H1).
- **Unfetchable signatures:** a signature that didn't fail but can't be fetched yet stops its stream without moving the cursor. It alerts after 5 minutes (audit H2).
- **Poison transactions:** a transaction whose effects fail to apply 5 times is recorded in `IndexerDeadLetter`, alerted on, and passed over, so one transaction can't halt indexing.
- **Missed transfers:** the mint stream cannot see plain SPL `Transfer`s (they don't list the mint), so balances are also resynced from chain (D-031).
- **Webhooks:** Helius webhooks only wake the indexer up; the cursors stay the source of truth.

### D-023 The platform admin can never be rotated

The PlatformConfig PDA seeds are `["platform_config", admin]`, so a new admin means a new platform. The mainnet platform must be created by the Squads vault directly: `pnpm platform:create -- --squads <vault>` prints the unsigned transaction to import in Squads (`MAINNET.md`).

### D-024 Workers' safety margins

- The buyback wallet keeps 0.01 SOL for fees and rent.
- Reconcile claims when Σ unclaimed holdersPart ≥ 1 SOL or hourly (`CLAIM_INTERVAL_SEC`), and never while the indexer is more than about 30 s behind.
- Harvest runs hourly per graduated coin (`HARVEST_INTERVAL_SEC`). A harvest that collected dust (< 0.002 SOL and no coin tokens) backs that coin off to every 6 hours (`Coin.nextHarvestAt`).

### D-025 Vanity mint addresses (optional, SPEC §4)

- **Grinding.** `pnpm vanity:grind` grinds mint keypairs ending in "back" offline.
- **Storage.** The secrets are stored AES-256-GCM-encrypted with `VANITY_KEY` (`VanityMint` table).
- **Use.** When `VANITY_ENABLED=1`, `/launch/tx` claims one with `FOR UPDATE SKIP LOCKED` and partially signs the launch with it. With none left it falls back to a random mint.
- **Key loss.** `VANITY_KEY` lives only in the server env. Losing it only loses unused vanity keys.

### D-026 Mobile wallets use deep links, not Mobile Wallet Adapter

The MWA packages need React Native, which can't be bundled into the Next.js app. On a phone without an injected wallet, the wallet modal opens the page inside the wallet app's browser instead. It uses Phantom `/ul/browse`, Solflare `/ul/v1/browse` and Backpack `/ul/v1/browse`. Revisit if MWA ships a web-only build.

### D-027 Telegram payout alerts are opt-in and carry no authority

- **Linking.** A holder signs a single-use, nonce-bound message to link a Telegram chat to their wallet.
- **Delivery.** The payout worker sends a best-effort message after a confirmed batch.
- **Bot scope.** The bot only reads `/start <code>` and never moves funds. Its webhook is checked with `TELEGRAM_WEBHOOK_SECRET`.

### D-028 Jupiter buybacks: instructions are checked and compiled locally

When `JUPITER_BUYBACKS=1`, the buyback key never signs a transaction built elsewhere.

1. The worker fetches Jupiter's `/swap-instructions`.
2. It checks every instruction against an allowlist (`apps/workers/src/jupiter.ts`):
   - only Jupiter v6, ATA creation for the payer's own accounts, and System/SPL Token instructions limited to the payer's own wSOL;
   - no foreign signers;
   - the swap must pay the distributor's token account.
3. It compiles the transaction itself, with our payer, blockhash and compute budget (Jupiter's priority fee is dropped).
4. It simulates with account snapshots and requires both:
   - the buyback wallet loses at most `amount + 0.01 SOL`;
   - the distributor gains at least `minOut`.

If any of this fails, the CPMM path is used (audit H5).

### D-029 Money invariants check chain first and need two sightings

- **Order.** Chain balances (distributor tokens, buyback SOL) are read before the DB snapshot. Anything that moves in between, such as a payout or buyback landing, then errs on the safe side.
- **Two sightings.** A shortfall must appear on two consecutive checks before it pauses a coin's payouts or all buybacks (audit M2).
- **Fees.** Buyback network fees no longer drift the SOL invariant, because D-034 charges them to the coin.

### D-030 Referral program deferred

A referral share would change the 1.1% split in `config/fees.json`, or add a fee on top. Either one changes what traders, holders or the platform receive, so it is the owner's decision (SPEC §2.1: rates don't change silently). Not built. To add it: pick the share and who pays it, add it to `fees.json`, and pass a referrer account. LaunchLab has a `share_fee` slot in `TradeEvent` for this.

### D-031 Holder balances are checked against chain before money moves

The mint stream can't see plain SPL `Transfer`s, because they don't list the mint account. A wallet could otherwise inflate its recorded balance for free, with an invisible transfer out and a visible transfer back, or sell without being flagged (audit C1). So:

- **TransferChecked.** Payouts use `TransferChecked`, so our own transfers are visible.
- **Sync on demand.** `syncHolders` reads every token account of the mint (`getProgramAccounts`, Token program, mint filter) and corrects each holder's balance. It runs only in the indexer process, right after that coin's mint stream, so the indexer is the single writer of balances. It runs when:
  - a computed balance would go negative (that proves a missed transfer in);
  - a buyback is about to be credited (the sync must be newer than the window end);
  - a payout round starts for a coin with pending rewards (the sync must be newer than the round start).
- **Recorded too high.** A wallet whose recorded balance was above the real one is corrected and flagged as decreased (forfeiture). It is also marked `mismatchAt`, which excludes it from the buyback distribution of that window.
- **Recorded too low.** It is corrected with no penalty.
- **Already-synced changes.** Mint-stream changes at or below the sync slot are already in the synced balance and are skipped.
- **Flag reset.** It is per wallet and only for decreases recorded before the payout snapshot (`lastDecreaseAt`), so a sale during a payout isn't lost (audit M1).
- **Cost:** one `getProgramAccounts` per credited buyback round and per payout. VERIFY on devnet that Helius serves `getProgramAccounts` for the Token program with a mint `memcmp` filter quickly enough. A coin with very many holders may need the Helius DAS `getTokenAccounts` call instead.

### D-032 Only LaunchLab's own self-CPI events are trusted

LaunchLab emits trade and create events via `#[event_cpi]`. These are an inner instruction to itself, and the program checks its event-authority PDA signed, so no other program can produce one. The earlier fallback that read "Program data:" log lines was removed: any program can write such a line, and a forged `TradeEvent` could have credited any coin's buyback budget (audit C2). Malformed events are skipped with a warning instead of throwing.

Migrations derive the LaunchLab pool from the mints. The IDL puts `pool_state` at index 17, not 18, and the old index made graduations invisible (chain audit H1). A trade event can't move a GRADUATED coin back to MIGRATING.

### D-033 Vault claims are matched to accruals after they land

`claim_platform_fee_from_vault` empties the whole vault, including fees of trades the indexer hasn't seen yet. A claim now:

1. records the slot it landed in;
2. waits until the platform stream has passed it (the claim references the PlatformConfig);
3. then attaches every accrual with `trade.slot ≤ claim slot` and compares (audit M3).

### D-034 Buyback network fees are charged to the coin

The buyback wallet pays network fees and, on a coin's first buyback, the distributor's token-account rent. This overhead is the buyback wallet's lamport change minus the swap amount. It is taken from that coin's budget. A buy that failed on chain refunds the budget minus its fee.

The curve chunk is capped at what completes the curve, as the SDK does. If the program still takes less SOL than sent, the difference is returned to the budget and `paidToHoldersLamports` counts only what was spent (audit L1, L4).

### D-035 Worker leases instead of advisory locks

A session advisory lock lived on one pooled Prisma connection. It was silently lost if the pool recycled that connection, and a second copy that missed it idled forever, so `pm2 reload` left the worker stopped. Each worker now holds a 30 s lease row (`WorkerLease`) and renews it every 10 s:

- a waiting copy retries every 5 s;
- a lost lease stops new ticks;
- shutdown releases the lease after the current tick (audit L5).

### D-036 Metadata of coins from other frontends is untrusted

Anyone can launch under our PlatformConfig.

- **Fetching.** The indexer stores the coin first and fetches its metadata later, outside every DB transaction (`fillMetadata`, up to 5 attempts). It accepts https or ipfs only, refuses private addresses at connect time, uses one 6 s deadline that covers the body, caps the size at 64 KB, and follows no redirects.
- **Validation.** The JSON is checked with `cleanMetadata`:
  - text is length-capped with control and bidi characters stripped;
  - links must be https, with x.com/t.me host rules;
  - images are only taken from IPFS and rewritten to our gateway.
- **Hidden until reviewed.** Tickers that aren't plain letters and digits (lookalikes) and Token-2022 mints (payouts can't serve them) are hidden. Token-2022 coins also have buybacks and payouts off (audit H4, M4, L2).

### D-037 Landing and expiry rules

- **Failed.** A transaction is "failed" only when its error is seen at `confirmed` or `finalized`. A `processed` error can come from a minority fork.
- **Dropped.** A transaction is "dropped" only when the *finalized* block height is more than 20 blocks past its `lastValidBlockHeight`.
- **Not readable yet.** A landed transaction whose effects can't be read yet (RPC lag) is never settled as zero. Buybacks, harvests and claims stay open and are retried (audit H3, M4, chain M1, M2).

### D-038 Address lookup table is frozen

`pnpm alt:create` freezes the table in the same transaction, so the hot authority key can't deactivate or close it. Pass `--no-freeze` to keep it extendable. VERIFY on devnet that freezing in the creating transaction is accepted.

### D-039 The harvest's platform share goes to the treasury

The platform third of harvested SOL is sent to `TREASURY_PUBKEY` in the settlement transaction, so it doesn't accumulate in the hot claim wallet (CLAUDE.md rule 6).

### D-041 Admin is CLI-only (owner decision, 2026-11-04)

The owner asked to remove the admin page and its wallet sign-in. There is no `/admin` page, no `/admin/*` API and no `AdminSession` table any more, and `ADMIN_WALLETS` is gone.

- Every admin task runs on the server as `pnpm admin <command>` (`scripts/src/admin.ts`), on the same actions as before (`packages/db/src/admin.ts`):
  - overview;
  - coins and reports;
  - hide and unhide;
  - exclusions;
  - pause and resume;
  - claims and approving held claims;
  - failed jobs and harvest retries;
  - indexer dead letters;
  - the audit log.
- Access control is SSH plus the database credentials.
- Writes are audited in `JobLog` as `cli:<user>@<host>`. Commands that make money move again need `--yes`.
- This removes the replayable-token risk (audit M5) entirely.

### D-042 Several wallets per visitor, with logos

- **Wallet list.** The connect dialog lists Phantom, Solflare, Backpack, OKX Wallet, Coinbase Wallet, Trust Wallet, Bitget Wallet, Magic Eden and Exodus, each with its own logo.
  - Installed wallets use the icon they register.
  - Others use icons taken from the official `@solana/wallet-adapter-*` packages (Apache-2.0). OKX has no such package, so its five-square mark is drawn as SVG.
  - Wallets that aren't installed link to their download page, or open the site in the wallet's in-app browser on phones where the wallet has a documented link.
- **Several wallets.** A visitor can add more than one wallet. The list (address and wallet name only, no secrets) is kept in the browser's localStorage, so it is a per-device convenience.
  - One wallet is connected (active) at a time; switching reconnects through that wallet.
  - Two accounts in the same wallet app are switched inside the app (Backflow follows the account it reports).
  - The Rewards page can show all saved wallets together. Claims and Telegram linking always use the active wallet, because they need its signature.

### D-043 Mainnet without a devnet run (owner decision, 2026-11-05)

The owner approved mainnet in chat and chose to go straight to mainnet, skipping the devnet run that `MAINNET.md` §0 lists as a precondition. The open VERIFY items below are confirmed on mainnet instead, with small amounts, in this order:

1. **Prepare, no transactions.** `deploy/mainnet-1-prepare.sh` sets up the database, users, hot keys and the live env files in `/etc/backflow-live`, then runs a read-only `platform:create` dry run. The demo keeps running on `/etc/backflow`.
2. **Create.** Fund the hot wallets with small amounts, then `platform:create --send` (or `--squads <vault>`) and `alt:create --send`. Each one is dry-run first.
3. **Switch, paused.** Switch the site to the live env with buybacks and payouts paused (`pnpm admin pause buybacks`, `pnpm admin pause payouts`).
4. **Small-cap test.** Run the test in `MAINNET.md` §4 (one coin, first buy ≤ 0.1 SOL). Resume one worker at a time, and tick each VERIFY item from the real transactions.
5. **Public.** Announce only after a full buyback-and-payout cycle has reconciled.

**Risk the owner accepted.** A layout or account-order mismatch shows up on mainnet first. Every send is simulated before it goes out, so a mismatch fails without moving funds, but it can stall launches or payouts until it's fixed.

**RPC budget.** The indexer polls the platform, and each coin, every `INDEXER_INTERVAL_MS` (3 s). That is about 0.9M Helius credits a month for the platform and about as much again per active coin. The Helius free plan (1M a month) covers only the small-cap test, so move to a paid plan before going public. The browser uses Helius's Secure RPC URL, so the server key never reaches the page.

`pnpm db:deploy` called pnpm's built-in `deploy` command instead of the package script. It now uses `pnpm --filter @backflow/db run deploy`.

### D-044 The owner deals with two addresses (owner request, 2026-11-05; superseded by D-045)

The owner found five wallets too many. On chain there are still five, because holders' money has to stay apart from the platform's:
- the buyback wallet's balance is checked against the holders' budgets (`checkInvariants`);
- every move between the wallets is a separate, public transfer.

Merging them would weaken both of those checks and change money code right before an untested mainnet start. What the owner sees is two addresses:

1. **Treasury.** The owner's profit wallet. It is created by `deploy/show-keys.sh`, and its private key is shown once and never stored on the server.
2. **Server wallet.** This is the platform fee wallet, the only address the owner sends SOL to. `pnpm wallets:fund` tops up the admin (0.01 SOL), buyback (0.05) and distributor (0.02) wallets from it, and the server wallet keeps 0.01. These targets are the low-balance alert floors, so 0.1 SOL is enough to start. Claims are measured from the fee vault's balance change, so SOL sent here doesn't affect reconciliation.

**Admin key.** After the platform is created, `deploy/mainnet-2-create.sh` offers to remove the admin key from the server. The owner keeps the copy shown by `show-keys.sh`, and only needs it again for `platform:update`.

### D-045 Two wallets: treasury and one server wallet (owner decision, 2026-11-05)

The owner wanted exactly two wallets, and this replaces the five-wallet setup of D-044. `deploy/new-wallets.sh` creates them before the platform exists, and only once the old wallets are confirmed empty. The old key files are kept aside, not deleted.

1. **Treasury.**
   - It is the owner's profit wallet and the **platform admin**. Its private key is shown once and never written to the server.
   - `deploy/mainnet-2-create.sh` asks for it once, to sign `platform:create`. While signing, it is kept in `/dev/shm` and shredded on exit.
   - Having the admin off the server is safer than D-044: a break-in on the server can't take over the platform.
2. **Server wallet.** One key for the claim-fee, lock NFT, buyback and distributor roles. `platform-fee.json`, `buyback.json` and `distributor.json` are copies, each owned by its worker's user.

**What changed in the code.**
- The claim transfer and the harvest settlement skip transfers to self, so only the platform's share moves, to the treasury. A claim with nothing to move is marked done without a transaction.
- The low-balance alert adds up the floors of the roles that share a wallet.
- `wallets:fund` keeps the merged roles' targets in the server wallet, and tops up the treasury only to pay for creating the platform.

**What the owner gave up.**
- **Key isolation between workers.** The buyback, payout and fee workers now hold the same key, so a break-in on any one of them reaches the whole server wallet.
- **Invariant 2 is less sensitive.** The buyback wallet check (`checkInvariants`) now also counts the server wallet's operating SOL and the platform share in transit. A real shortfall therefore shows up later.

Both are limited by keeping only working balances on the server wallet.

### D-046 PM2 per-process users: the shared group is the primary group

When PM2 (as root) starts a process with `uid`/`gid`, Node (libuv) calls `setgroups(0)`, which drops every supplementary group. Membership in `bf-env` therefore didn't count, and with `BACKFLOW_SPLIT_USERS=1` every API and worker process failed at start with `common.env: not found`. This was reproduced with PM2 4.x.

The fix:
- API and worker processes run with `gid: "bf-env"`.
- `common.env` stays `root:bf-env 0640`.
- Each process's own `<name>.env` is owned by its user (`<user>:root 0400`), so no worker can read another's file.
- The web keeps `backflow:backflow` and reads only `web.env`.

`deploy/mainnet-3-live.sh` applies this ownership, switches the site to live with buybacks and payouts paused, and has `--back-to-demo` to undo. It was checked locally: all seven processes came up under their own users and read their env files and keys.

### D-047 The site reaches Solana through our API (owner request, 2026-11-05)

The owner didn't want a second Helius key or URL. The site's RPC is therefore `https://rebuy.fun/api/rpc`: the API's `POST /rpc` forwards JSON-RPC to the server's `RPC_URL`, so the Helius key never reaches the page. This is the "proxy through a server" option in Helius's own guidance.

Limits on the route:
- **Methods.** Only the 19 that a wallet page needs are forwarded (balances, blockhash, sending and simulating transactions, signature status, accounts). `getProgramAccounts`, history and block methods are refused, so the route can't be used as a free general RPC on our key.
- **Size and rate.** Batches are capped at 10 calls. Requests share the per-client rate limits of Nginx and the API.

Without a WebSocket, the wallet balance is polled every 15 s instead of subscribed. The site's calls count against the same Helius plan as the workers. `BROWSER_RPC_URL=<Helius Secure RPC URL>` on `mainnet-3-live.sh` switches back to a direct URL.

### D-048 Coin images on our own server (owner request, 2026-11-05)

The owner chose to keep coin images and metadata on the VPS instead of Pinata/IPFS.

**How it works.**
- Without `PINATA_JWT`, `POST /launch/metadata` stores the cleaned image and the metadata JSON under `MEDIA_DIR` (`/var/lib/rebuy/media`, owned by `bf-api`).
- Each file is named by the SHA-256 of its bytes.
- The API serves them at `https://rebuy.fun/api/media/<sha256>.<ext>`, with an immutable cache header and CORS `*` so wallets and explorers can read them.

**What is trusted.** Coin images are accepted only in exactly that shape (`ownMediaImage` in core), next to IPFS. Any other host, scheme, extension or path is still dropped (audit M4 still holds). Uploads keep every check from before: type sniffing, size limits, re-encoding.

**Risk the owner accepted.** The on-chain metadata links point at rebuy.fun and can't be changed later. If the server and its backups are lost, or the domain lapses, the logos and descriptions of coins launched here break for good. Pinata/IPFS would not have that dependency.

**Mitigations.**
- `mainnet-3-live.sh` installs a nightly backup of the database and the media folder (`deploy/backup.sh`, 14 days). Copy those backups off the server too.
- Setting `PINATA_JWT=...` later switches new launches to IPFS.

### D-040 Known limits kept on purpose

- **No-ATA holders.** Holders whose tokens sit in a non-associated token account are never paid. Their pending rolls over. Payouts only go to the canonical ATA (SPEC §3.3).
- **PDA wallets.** Wallets owned by a PDA (off-curve), such as Squads vaults or smart wallets, are treated like program accounts and earn no TWAB.
- **Fee Key account.** The harvest assumes the Fee Key NFT sits in the platform wallet's ATA. The lock program mints it there.
- **Closing wSOL.** User buys close the user's canonical wSOL account, which also unwraps any wSOL they already held. Nothing is lost.

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

### Still to confirm on devnet (from the November audit)

- [ ] `migrate_to_cpswap` deployed account order: our parser derives the pool from the mints and warns if index 17 differs.
- [ ] Whether LaunchLab and CPMM accept a base-token account owned by someone else (the distributor) as the buy's receiving account (D-017). The pre-send simulation fails safely if not.
- [ ] What the program does when `buy_exact_in` sends more SOL than completing the curve needs (we cap like the SDK; D-034 refunds any difference).
- [ ] `TradeEvent.amount_in` on buys: gross or net of fees (the indexer assumes gross).
- [ ] Whether the GlobalConfig has `requires_platform_auth = 1`, and which PDA it expects (`platform_allow_config` per SDK vs `platform_global_access` in the IDL).
- [ ] Compute usage of launch + first buy, including first-time fee vault creation.
- [ ] Freezing the lookup table in its creating transaction (D-038).
- [ ] `getProgramAccounts` (Token program, mint filter) speed on Helius for the holder sync (D-031).

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
