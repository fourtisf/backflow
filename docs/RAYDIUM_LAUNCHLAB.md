# Raydium LaunchLab integration notes

> **Verification status (2026-11-04, Milestone 1).** Checked against `@raydium-io/raydium-sdk-v2` 0.2.81-alpha, the official demo, the LaunchLab IDL and `raydium-cpi`. Corrections from that check are marked **Updated** below. The full evidence is in `docs/DECISIONS.md`. On-chain values are still unread because the build environment had no Solana RPC access; `pnpm platform:show` prints them.

These notes come from Raydium's documentation and public reporting as of early November 2026. LaunchLab changes over time, and it was upgraded on 2026-08-17. **Treat every item marked VERIFY as unconfirmed until you check it** against:

- the SDK source: `@raydium-io/raydium-sdk-v2`, folder `src/raydium/launchpad/`;
- the official demos: `raydium-sdk-V2-demo/src/launchpad` (createMint, buy, sell, claimCreatorFee, collectAllCreatorFees, platform creation);
- the LaunchLab IDL bundled with the SDK;
- the live on-chain accounts (`GlobalConfig`, our `PlatformConfig`, pool state).

## Program addresses (mainnet)

**VERIFY** these in Raydium's `reference/program-addresses`.

| Program | Address |
|---|---|
| LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` |
| CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` |
| Burn & Earn (LP lock) | `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE` |

**Updated:** all three match the SDK (`src/common/programId.ts`). Devnet IDs from the same file:

| Program | Devnet address |
|---|---|
| LaunchLab | `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6` |
| CPMM | `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` |
| Burn & Earn (LP lock) | `DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX` |

GlobalConfig for wSOL, constant product, index 0: mainnet `6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX`, devnet `7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt` (seeds `["global_config", quote_mint, u8 curve_type, u16 index]`). Every SDK launchpad method defaults to the mainnet program, so devnet calls must pass `programId` explicitly. Constants live in `packages/core/src/chain.ts`.

## Concepts

- **GlobalConfig**: protocol-level config, created by Raydium's admin. There is one per `(quote_mint, curve_type, index)`. It sets the protocol `trade_fee_rate`, `migrate_fee`, and the floors that every launch must satisfy. We cannot change it; we pick one.
  - Fee rates are in units of **1/1,000,000** of volume. **Updated:** `PlatformConfig` uses the same denominator (SDK `FEE_RATE_DENOMINATOR_VALUE`, applied to protocol, platform, share and creator rates alike).
  - Documented defaults at creation:
    - `min_base_supply` = 10,000,000
    - `max_lock_rate` = 30%
    - `min_base_sell_rate` = 20%
    - `min_base_migrate_rate` = 20%
    - `min_quote_fund_raising` = 30,000,000,000 quote base units (30 SOL for wSOL)
  - The live config may differ. **VERIFY**.
- **PlatformConfig (Platform PDA)**: our platform. It is derived from our platform admin key (seeds `["platform_config", platform_admin]`, **verified**; one platform per admin wallet). Create it with `createPlatformConfig` and update it with `updatePlatformConfig`, one update per epoch; `creator_fee_rate` changes only via the `updateAll` variant. It holds:
  - `fee_rate`: our platform fee on curve trades. We set **0.675%**.
  - `creator_fee_rate`: the creator fee on curve trades. We set **0.175%**.
  - `migrateCpLockNftScale { platformScale, creatorScale, burnScale }`: three values that must sum to 1,000,000. Since the 2026-08-17 upgrade, `creatorScale` must be 0 (the program asserts this), and `platformScale + creatorScale` becomes one platform-owned locked-LP position with a Fee Key NFT. We set **1,000,000 / 0 / 0**. **Updated:** neither the SDK nor the IDL contains a `creatorScale == 0` check, and the official demo still uses 500,000. It may be an on-chain rule newer than these sources. Our 1,000,000 / 0 / 0 is valid under either reading.
  - `cp_config_id`: which CPMM `AmmConfig` (fee tier) graduated pools use.
  - `platformCpCreator`: who is recorded as the CPMM pool creator for the CPMM creator fee. **Updated:** per the IDL, if set, it becomes the migrated CPMM pool's creator and takes the CPMM creator fees. It cannot be set at creation, only with `updatePlatformConfig`. We leave it unset so the token creator keeps them.
  - `restrict_global_config` plus `PlatformAllowConfig` PDAs: optionally restrict which `GlobalConfig`s can launch under our platform.
  - Branding metadata: name, description, image.
- **Fee caps**: platform fee is documented as capped at 1% (100 bps). One source says the creator fee is capped at 0.5%, but Raydium's GlobalConfig page describes `max_share_fee_rate` as the cap on the *referral share fee* instead. **VERIFY** the real cap for `creator_fee_rate`. 0.175% is under both readings. **Updated:** the SDK and IDL have no per-fee cap, only "total fee ≤ 100%". Any cap is on chain only and still unverified.
- **Protocol fee**: reported as a static 0.25% on LaunchLab curve trades, separate from the platform fee. **VERIFY** by reading `GlobalConfig.trade_fee_rate` on chain for the config we use.

## Fees on a curve trade

Each buy or sell can include four additive fees: protocol (Raydium), platform (us), creator, and referral share (per transaction, optional). We do **not** set a referral share fee.

Where each fee accrues:
- **Platform fees** go to a vault PDA with seeds `[platform_config, quote_mint]`. It is **shared by every coin on our platform** that uses that quote mint. Our `platform_fee_wallet` claims it with `ClaimPlatformFeeFromVault`. This is why Backflow must attribute fees per coin off-chain (see SPEC §6.3). **Updated:** the seeds are the PlatformConfig account key plus the quote mint, with no string prefix. The SDK method is `launchpad.claimVaultPlatformFee` (`claimPlatformFeeFromVault` is the instruction builder). It pays into the SDK owner's token account, so it must run as the claim-fee wallet.
- **Creator fees** go to a creator vault (per creator and quote mint). The creator claims them with `ClaimCreatorFee`; the SDK helpers are `collectCreatorFees` or `claimCreatorFee`. **Updated:** the LaunchLab helper is `launchpad.claimCreatorFee` (batch: `claimMultipleCreatorFee`). `collectCreatorFees` is the **CPMM** method used after graduation. The vault is `[creator, quote_mint]`, with no pool or platform in the seeds, so one vault holds a creator's fees from all their LaunchLab coins and one claim empties it.

**Updated: fee rounding.** The SDK computes `total = ceil(amount × (protocol + platform + share + creator) / 1e6)` on the SOL side: SOL in for buys, gross SOL out for sells. Platform, creator and share portions are `floor(total × rate / totalRate)`; protocol takes the remainder. `packages/core` `tradeFees()` mirrors this. The IDL `TradeEvent` carries the exact `protocol_fee`, `platform_fee`, `creator_fee` and `share_fee` for each trade, so the indexer should read those.

## Graduation

- A launch graduates when the quote vault reaches `quote_reserve_target`, which is derived from curve parameters plus fees.
- New launches must use `migrate_type = 1` (CPMM). **Updated:** the SDK and IDL accept 0 (AMM) and 1 (CPMM); CPMM is forced only for Token-2022 mints or by platform curve rules. Backflow passes 1 because the Fee Key, `cp_config_id` and CPMM creator fee need it.
- Raydium's `migrate_to_cpswap_wallet` crank signs `MigrateToCpswap`, so graduation lands shortly after the target is hit.
- At graduation, LP tokens are minted. With our scales, 100% are locked through Burn & Earn, and the platform receives the Fee Key NFT for that pool. The Fee Key earns the LP-fee side of the pool's trade fee. It does not allow withdrawing liquidity.
- CPMM creator fees, if configured, are additional to the trade fee and are collected separately with `collectCreatorFee()`.
- Pool status flow: 0 (trading) → 1 (migrate) → 2 (migrated). The indexer watches this. **Verified** (IDL `PoolStatus { Fund, Migrate, Trade }`).
- **Updated: harvest.** `raydium.cpmm.harvestLockLp({ poolInfo, nftMint, lpFeeAmount, programId, authProgram, cpmmProgram })`. It derives the Fee Key token account from the fee payer, so the NFT owner must pay. On devnet, pass all three program overrides.

## What Backflow builds on top
- A frontend that launches with our Platform PDA.
- An indexer filtered to our platform.
- Off-chain fee attribution, buyback, and payout workers.
- A Fee Key harvest worker for graduated pools.

Float (floatlaunch.xyz) uses the same base: LaunchLab plus a custom program and bots. Their docs are a useful reference for operational choices, such as buyback sizing at about 5 SOL or every 4 hours with a 1% price cap, and a $0.50 minimum payout.

Known gotcha, from Float's docs: platform fee tiers are public. Other apps can launch coins under our Platform PDA. Those coins still pay our platform fee, so index them. Moderate them before showing them on the board.

## VERIFY checklist (tick each in `docs/DECISIONS.md` with the evidence)

Status as of Milestone 1 is tracked in `docs/DECISIONS.md` → "VERIFY checklist".
- [ ] LaunchLab, CPMM, and Burn & Earn program IDs (mainnet and devnet)
- [ ] `GlobalConfig` to use for wSOL constant-product: its `trade_fee_rate` (is it 0.25%?), `migrate_fee`, and floors
- [ ] `PlatformConfig` field names, units (1e6 denominator?), caps, and the create/update instruction names in the SDK
- [ ] Creator fee: rate cap, vault derivation, claim instruction or SDK helper
- [ ] Platform fee vault derivation and the claim instruction
- [ ] Whether trade events/logs expose exact fee amounts per trade
- [ ] Curve parameter limits for 1B supply, 80% sold, 85 SOL target
- [ ] Mint and freeze authority are revoked on initialize
- [ ] Available CPMM `AmmConfig` fee tiers and their LP/protocol/fund split; pick `cp_config_id`
- [ ] Fee Key harvest flow for platform-owned locked LP (SDK method and accounts)
- [ ] `platformCpCreator` behavior for CPMM creator fees
- [ ] Devnet availability

## Sources
- Raydium docs, LaunchLab platforms: https://docs.raydium.io/products/launchlab/platforms
- Raydium docs, GlobalConfig: https://docs.raydium.io/products/launchlab/global-config.md
- Raydium docs, bonding curve: https://docs.raydium.io/products/launchlab/bonding-curve.md
- Raydium docs, LaunchLab and CPMM fee reference: https://docs.raydium.io/products/launchlab/tips-and-gotchas/launchlab-cpmm-fee-reference.md
- Raydium docs, LP fee distribution: https://docs.raydium.io/products/launchlab/tips-and-gotchas/lp-fee-distribution.md
- Raydium docs, accounts: https://docs.raydium.io/products/launchlab/accounts
- Solana Compass, the LaunchLab CPMM-only upgrade (2026-08-17): https://solanacompass.com/news/raydium-launchlab-mandates-cpmm-only-graduation-and-locks-creator-lp-at-token-migration
- Blockworks, the LaunchLab 0.25% static fee: https://blockworks.co/analytics/raydium/raydium-launchlab/raydium-launchlab-platforms
- Float docs, a reference implementation on LaunchLab: https://www.floatlaunch.xyz/docs
