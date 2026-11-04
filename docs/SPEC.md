# Backflow — product and technical specification

Version 1.0 · 2026-11-04 · Owner: ALFA (Fourtis)

Working name is **Backflow**. The brand name and domain may change; keep them in config.

---

## 1. Product in one paragraph

Backflow is a Solana memecoin launchpad. Anyone can launch a coin on a Raydium LaunchLab bonding curve through our platform. Every buy and sell costs **1.1%**. Of that, **0.45% of trade volume buys the same coin back on the market**, and the bought tokens are **distributed pro rata to the coin's holders**. Holders who sell before a payout forfeit their pending tokens to the holders who stayed. The rest of the fee goes to the platform (0.225%), the creator (0.175%), and Raydium's protocol fee (0.25%). At the graduation target the coin migrates to a Raydium CPMM pool with liquidity locked forever, and LP fees from that pool keep funding buybacks.

Why it's different from pump.fun:
- The total fee is lower: 1.1% versus 1.25% on pump.fun's curve.
- Holders get paid in the coin itself.
- Dumping early is penalized without raising the fee, because selling forfeits pending rewards.

---

## 2. Fee model (canonical values in `config/fees.json`)

### 2.1 Bonding-curve phase

| Recipient | Rate of trade volume | How it's collected on-chain |
|---|---|---|
| Raydium protocol | 0.25% | LaunchLab `GlobalConfig.trade_fee_rate`. Set by Raydium, not us. **VERIFY** the live value. |
| Holders (buyback budget) | 0.45% | Part of our **platform fee** (`PlatformConfig.fee_rate` = 0.675%) |
| Platform | 0.225% | Part of our **platform fee** |
| Creator | 0.175% | LaunchLab native creator fee (`PlatformConfig.creator_fee_rate`), claimed by the creator directly from Raydium |
| **Total paid by trader** | **1.1%** | |

The platform fee of 0.675% is split off-chain by our accounting:
- holders' share = 0.45 / 0.675 = **2/3** of every platform-fee lamport;
- platform share = 0.225 / 0.675 = **1/3**.

Use exact rational math: `holders = floor(fee * 2 / 3)`, and `platform = fee - holders` so rounding dust goes to the platform.

**Worked example: a 1 SOL buy**
- Raydium protocol: 0.0025 SOL
- Platform fee vault: 0.00675 SOL, which splits into 0.0045 SOL for this coin's buyback budget and 0.00225 SOL for the platform
- Creator fee vault: 0.00175 SOL
- Total fee: 0.011 SOL

If the live Raydium protocol fee differs from 0.25%, **do not change our rates silently**. Surface the real total in the UI and tell the owner, who decides whether to adjust `fee_rate` to keep the 1.1% promise.

### 2.2 After graduation (CPMM pool)

- At graduation, LaunchLab migrates liquidity to a CPMM pool. Set our platform's `migrateCpLockNftScale` to `platformScale = 1_000_000, creatorScale = 0, burnScale = 0`. All LP is then locked through Burn & Earn and the platform receives the **Fee Key NFT** for each pool. Liquidity can never be withdrawn, but LP fees are claimable.
- The CPMM pool's swap fee is set by the `AmmConfig` chosen with `cp_config_id`. Pick the tier closest to 1% and **VERIFY** the tier's trade fee and its LP/protocol/fund split. Show the real post-graduation fee on the coin page.
- Harvested LP fees arrive as SOL plus the coin's own token. Default handling (see §14):
  - **SOL**: 2/3 goes to that coin's buyback budget, 1/3 to the platform.
  - **Coin tokens**: 100% go straight to the holder distribution, with no selling, so there is no sell pressure.
- If a CPMM creator fee is available through `platformCpCreator`, route it to the original creator (**VERIFY** the mechanics).

---

## 3. Core mechanics

### 3.1 Buyback

- Each coin has a **buyback budget** in lamports, credited from fee accruals (§6.3) and harvests.
- When `budget >= BUYBACK_THRESHOLD` (default **1 SOL**), the buyback worker buys the coin:
  - **Pre-graduation**: a LaunchLab buy on the curve.
  - **Post-graduation**: a swap through the CPMM pool, or Jupiter if routing is better.
- **Price-impact cap**: a single buyback may not move the price more than `BUYBACK_MAX_IMPACT_BPS` (default **100 = 1%**). Quote first. If 1 SOL exceeds the cap, split it into smaller chunks spaced at least `BUYBACK_MIN_SPACING_SEC` (default 20s) apart.
- Set slippage protection from the quote, so a front-runner cannot extract more than the cap.
- Bought tokens land in the **distributor wallet**. That wallet is excluded from rewards.
- The buyback's own trade pays the 1.1% fee too. Accept this; it is a small cost and recycles part of itself.
- Every buyback writes a `Buyback` row (pending → sent → confirmed or failed) with the transaction signature, SOL spent, tokens received, and the holder snapshot id.
- Note on the curve: buybacks add SOL to the curve, so they move the coin toward graduation. That is fine and intended.

### 3.2 Who earns: time-weighted shares

To stop anyone from buying just before a buyback and selling right after, shares are **time-weighted**:

- For each coin, track every eligible wallet's balance over time (balance-change events from the indexer).
- At each buyback `k`, compute each wallet's **time-weighted average balance (TWAB)** over the window since buyback `k-1` (or since launch for the first one).
- A wallet's share of buyback `k` is `TWAB(wallet) / Σ TWAB(all eligible wallets)`.
- Credit `tokensBought × share` to the wallet's **pending** balance for that coin. Use integer math; leftover dust carries to the next distribution.

**Excluded from shares** (they hold tokens but never earn):
- the bonding curve base vault (LaunchLab pool vault);
- the CPMM pool vaults after graduation;
- the distributor wallet, buyback wallet, platform wallets, and treasury;
- the burn/incinerator address and any address in the `ExcludedAccount` table (owner-editable in admin);
- any account owned by a program rather than a wallet (detect via the token account owner's program; **VERIFY** the edge cases).

### 3.3 Payout and forfeiture

- Every `PAYOUT_INTERVAL_SEC` (default **300s** in production; the prototype UI says one minute, so make the copy read from config), the payout worker sends each wallet its pending tokens for every coin.
- **Minimum payout**: if a wallet's pending value is below `MIN_PAYOUT_USD` (default $0.50), it rolls over to the next round.
- **Forfeiture rule**: if a wallet's balance of coin X **decreased** since that coin's previous payout (a sell, or a transfer out), its pending X is forfeited. Forfeited tokens go back into the next distribution for X and are shared among the remaining holders. Pure increases (buys, transfers in) never forfeit.
- Transfers are batched (many SPL transfers per transaction). Recipients already hold the coin, so their token accounts exist and no rent is needed.
- Every payout writes a `Payout` row plus `PayoutItem` rows, and is idempotent per (coin, round, wallet).

### 3.4 Graduation

- LaunchLab graduates automatically when the curve's quote reserve reaches the target. Raydium's crank signs `MigrateToCpswap`.
- The indexer detects the status change, records the CPMM pool id, flips the coin to `graduated`, and switches buybacks to the pool.
- The harvest worker periodically harvests the platform Fee Key for each graduated pool (Burn & Earn harvest flow) and credits the results as in §2.2.

### 3.5 Creator fee

The creator claims directly from Raydium's creator fee vault. Our UI adds a **"Claim creator fees"** button on the creator's coin page and in a creator section of the Rewards page, which builds the `claimCreatorFee` / `collectCreatorFees` transaction (**VERIFY** the name in the SDK). We never custody creator fees.

---

## 4. Launch parameters

Every coin launched through Backflow uses our **Platform PDA** and these curve settings (**VERIFY** each against `GlobalConfig` minimums before use):

| Parameter | Value | Note |
|---|---|---|
| Quote mint | wSOL | |
| Curve type | constant product (`curve_type = 0`) | |
| Supply | 1,000,000,000 (6 decimals) | |
| Sold on curve | 80% (800,000,000) | Must leave ≥ `min_base_migrate_rate` (20%) for the pool |
| Graduation target | 85 SOL in the curve | Must be ≥ `min_quote_fund_raising` (30 SOL default) |
| Vesting / locked supply | 0 | |
| `migrate_type` | 1 (CPMM) | Mandatory for new launches |
| Mint/freeze authority | Revoked | LaunchLab does this; **VERIFY** |
| Token program | SPL Token (not Token-2022) | Simpler transfers for payouts |

**Launch flow**
1. The user fills the form (name ≤32, ticker 1–10 A–Z0–9 uppercase, description ≤140, image ≤4 MB png/jpg/gif/webp, optional X, Telegram, and website links, optional first buy in SOL).
2. The API uploads the image and metadata JSON to IPFS (Pinata) and returns the URI.
3. The web app builds the LaunchLab initialize transaction with our platform PDA. An optional first buy goes in the **same transaction**. The user signs it in their wallet. The launch is free; the user pays only the network fee.
4. The indexer picks up the new pool and the coin appears on the board.

**Ticker rule**: a ticker can exist only once on Backflow, checked case-insensitively in our database. A duplicate is blocked in the UI and API with: "$TICKER already exists on Backflow. Pick another ticker." Coins launched with our platform PDA from other frontends are still indexed (they pay our fees), but they are hidden until moderated if they duplicate a ticker.

**Optional, nice to have**: pre-grind vanity mint keypairs whose address ends in `back` (case-sensitive) and use one per launch, as Float does with `fLoat`. Grind off-line on the VPS and store them encrypted. This is low priority.

---

## 5. Pages (rebuild `prototype/backflow.html` faithfully)

Global elements:
- **Header**: logo; center pill nav (Coins, Launch, Rewards, How it works); right side shows the SOL balance and the wallet button.
- **Live strip**: below the header, the latest buybacks: "$TICKER +amount to N holders, time ago". New items slide in.
- On mobile, the nav becomes a floating bottom bar.

1. **Coins (home)**
   - **Hero**: a live pill with total SOL paid back to holders, the headline, the lead, two CTAs, and the fee-split card.
   - **Particle-ring canvas**: shows the top coin's vault progress toward the next buyback. On each real buyback, the ring contracts and bursts outward. Port the `Flow` engine from the prototype as a client component.
   - **Floating cards**: next payout countdown and the latest buyback.
   - **Trending now**: 3 cards with a 24h sparkline, market cap, 24h change, paid to holders, and a vault ring.
   - **All coins table**: tabs (Trending, New, Near graduation, On Raydium), search, and columns (coin, 24h sparkline, market cap, 24h change, bonding curve progress or "On Raydium", paid to holders, vault ring). Market cap flashes green or red on meaningful moves.
2. **Coin page**: header card (avatar, name, ticker, contract address copy, socials, curve or locked tag, market cap and 24h change); stats (24h volume, paid to holders, buyback count, holders); candlestick chart (1m/5m/15m) with **buyback markers**; tabs for trades, buybacks (with tx links), and holders (excluded accounts tagged "No rewards", "You" highlighted).
   - **Right rail, trade panel**: buy in SOL or sell in tokens; presets; estimated output; fee breakdown; a forfeiture warning on sell when the user has pending rewards.
   - **Right rail, "Your buyback share"**: vault ring, balance, share, pending, paid so far, next payout.
   - **Right rail, bonding-curve card**: or the graduated card after graduation.
   - **Right rail, About**.
3. **Launch**: three steps (name and image, links, first buy), live preview card, and a creator earnings calculator (volume slider × 0.175%, plus × 0.45% bought back for holders).
4. **Rewards**:
   - Not connected: a gate plus the global buyback ledger.
   - Connected: summary (paid so far, pending with countdown, holdings value, coins earning), a per-coin table, and the global ledger.
   - Add a **Creator** section listing the user's launched coins, with claimable creator fees and a Claim button.
5. **How it works**: big fee-split bar, the "one trade, start to finish" flow diagram (horizontal on desktop, vertical on mobile), coin life cycle, and rules.
6. **Admin** (new, not in the prototype; auth by a wallet allowlist and signature):
   - Hide or unhide coins; edit excluded accounts.
   - Pause or resume buybacks and payouts globally or per coin.
   - Hot-wallet balances, a reconciliation report, and failed jobs with a retry button.

Every number shown must come from the API or chain, refresh live over WebSocket, and degrade gracefully (show "–" plus a short reason) when data is missing.

---

## 6. Backend architecture

```
            ┌───────────── Helius RPC / webhooks / Geyser ─────────────┐
            │                                                          │
     ┌──────▼──────┐  trades, balances,   ┌──────────────┐     ┌───────▼──────┐
     │   indexer   │──── pool state ─────▶│  PostgreSQL  │◀────│ api (Fastify)│◀── web (Next.js)
     └──────┬──────┘                      └──────▲───────┘     └───────┬──────┘
            │ events (Redis pub/sub)             │                     │ WebSocket
            ▼                                    │                     ▼
   ┌────────────────┐  ┌──────────────┐  ┌───────┴──────┐  ┌──────────────────┐
   │ buyback worker │  │ payout worker│  │ harvest wkr  │  │ reconcile worker │
   └────────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘
          BullMQ queues in Redis, one job per coin action, idempotent keys
```

### 6.1 Indexer
- Subscribe to LaunchLab program activity filtered to pools whose `platform_config` is ours. Parse buys, sells, initializes, and migrations into `Trade`, `Coin`, and curve state.
- For graduated coins, subscribe to their CPMM pool swaps.
- Track **token balance changes** for every coin mint (Helius enhanced transactions or account subscriptions) into `BalanceEvent`. TWAB and forfeiture are computed from these.
- Compute price and market cap from curve virtual reserves (pre-graduation) or pool reserves (post-graduation). Get SOL/USD from Pyth or Jupiter's price API.
- Must be restart-safe: store the last processed slot and signature per stream, and backfill gaps on start.

### 6.2 API (Fastify)
- `GET /coins?tab=trending|new|near|raydium&q=`: board rows, including a 24h sparkline (32 points).
- `GET /coins/:mint`: detail.
- `GET /coins/:mint/candles?tf=1m|5m|15m`
- `GET /coins/:mint/trades`, `GET /coins/:mint/buybacks`, `GET /coins/:mint/holders`
- `GET /buybacks`: global ledger. `GET /stats`: total paid, next payout time.
- `GET /wallet/:address/rewards`: per-coin balance, share, pending, received, plus creator coins and claimable fees.
- `POST /launch/metadata`: multipart image plus fields; returns the IPFS URI. Rate limited.
- `GET /tickers/:ticker/available`
- `WS /live`: events `trade`, `price`, `vault`, `buyback`, `payout`, `graduated`, `coin_created`.
- ~~Admin routes are under `/admin/*` with wallet-signature auth.~~ Changed by the owner (2026-11-04): no admin page or admin API; admin tasks are CLI commands on the server (`pnpm admin`, DECISIONS D-041).

### 6.3 Fee accrual (off-chain attribution)

LaunchLab puts all platform fees for one platform and quote mint into a **single shared vault** (PDA seeds `[platform_config, quote_mint]`). We therefore attribute fees per coin ourselves:

- For each indexed trade: `platformFee = tradeQuoteAmount × fee_rate`. Use the **exact fee the program charged** if the event exposes it (**VERIFY**); otherwise recompute with the program's rounding.
  - **Updated (Milestone 1):** the IDL `TradeEvent` exposes the exact `platform_fee`. The program's rounding is `total = ceil(q × totalRate / 1e6)`, then `platform = floor(total × fee_rate / totalRate)` (see `docs/DECISIONS.md` D-003).
- Write a `FeeAccrual` row (coin, trade signature, platformFee, holdersPart, platformPart) and add `holdersPart` to the coin's `buybackBudget`.
- The buyback worker spends from the **buyback wallet**. The reconcile worker periodically claims the platform fee vault (`ClaimPlatformFeeFromVault`) into the platform fee wallet, then moves `Σ holdersPart` into the buyback wallet and `Σ platformPart` into the treasury.
- **Reconciliation**: claimed lamports must equal `Σ FeeAccrual.platformFee` for the claimed range within 0.5%. Otherwise alert and pause buybacks.

### 6.4 Wallets and keys

| Wallet | Purpose | Holds |
|---|---|---|
| Platform admin | owns the Platform PDA config | nothing (Squads multisig before mainnet) |
| Platform fee wallet | claims the platform fee vault | transit only |
| Buyback wallet | signs buybacks | buyback budgets (SOL) |
| Distributor wallet | holds bought tokens, signs payouts | pending reward tokens |
| Treasury | platform revenue | platform share |

Load keys from file paths in env, never from the repo. Add low-balance alerts.

---

## 7. Data model

See `prisma/schema.prisma`. Core tables:
- `Coin`
- `Trade`
- `BalanceEvent`
- `HolderState` (current balance plus TWAB accumulators)
- `FeeAccrual`
- `VaultClaim`
- `Buyback`
- `RewardCredit` (per buyback × wallet)
- `Pending` (per coin × wallet)
- `Payout`, `PayoutItem`
- `Harvest`
- `ExcludedAccount`
- `ModerationFlag`
- `JobLog`

---

## 8. Live updates and UI behavior
- The vault ring and the hero canvas read `vault` events (budget ÷ threshold).
- On a `buyback` event:
  - pulse the matching rings;
  - trigger the hero burst if it is the hero coin;
  - prepend to the live strip;
  - add a marker to the current candle;
  - if the user holds that coin, show the toast "+X added to your next payout".
- On a `payout` event, update Rewards and show "Payout landed: $Y in $A, $B sent to your wallet."
- Market cap flashes only on moves above 0.4%, to avoid noise.

---

## 9. Security
- No custody of user funds. Users sign their own launches and trades.
- Hot wallets are limited to their working balances, refilled automatically from the treasury below a threshold, with alerts.
- All jobs are idempotent, with `(type, coin, round)` unique keys. Before resending, check whether the previous signature landed.
- Never retry a transaction without checking the status of the previous attempt.
- Rate-limit public endpoints. Validate uploads by type, size, and dimensions, and strip EXIF.
- Use priority fees and simulate before sending. Slippage bounds come from quotes.
- Program and authority settings go through Squads multisig. Document every authority in `docs/AUTHORITIES.md`.
- Show a footer disclaimer: Backflow is not audited, coins are speculative, and the rules may change. Write a Terms page.

## 10. Observability
- Structured logs (pino) and a `JobLog` table.
- Health endpoint per worker.
- A Telegram alert bot for: reconciliation mismatch, low hot-wallet balance, failed payouts above a threshold, indexer lag above 30s.
- An admin dashboard page showing these.

## 11. Testing
- Unit tests:
  - fee split rounding;
  - 2/3 / 1/3 split;
  - TWAB with deposits and withdrawals mid-window;
  - forfeiture (sell, transfer out, partial sell, buy-only);
  - exclusions;
  - minimum payout rollover;
  - impact-cap chunking.
- Property test: Σ credited + dust = tokens bought, for any balance history.
- Devnet integration: launch → trades (`pnpm sim`) → buyback → payout → graduation → harvest.
- Reconciliation test against real devnet vault claims.

## 12. Deployment
- Hostinger VPS (Ubuntu), Node 20 LTS, PostgreSQL 16, Redis 7.
- PM2 processes: `web`, `api`, `indexer`, `buyback`, `payout`, `harvest`, `reconcile`.
- Nginx with TLS (Let's Encrypt): `/` goes to web, `/api` and `/live` go to api.
- Nightly Postgres backups.
- `docs/DEPLOY.md` with step-by-step commands.

## 13. Milestones (stop and report after each)
1. **Foundation**: monorepo, design system tokens from the prototype, all pages ported with mock data, wallet connect. Platform PDA created on devnet with the fees from `config/fees.json`.
2. **Launch**: IPFS upload, initialize plus first buy in one transaction, ticker uniqueness, coin appears.
3. **Indexer and live data**: trades, curve state, prices, candles, balances, WebSocket; board and coin page fully live.
4. **Trading**: buy and sell on the curve from the coin page, with fee breakdown and slippage settings.
5. **Fee accrual and buybacks**: `FeeAccrual`, budgets, buyback worker with impact cap, ledger pages.
6. **Rewards**: TWAB credits, pending, payouts, forfeiture, Rewards page, toasts.
7. **Graduation**: migration detection, pool trading, Fee Key harvest, post-graduation buybacks.
8. **Creator and admin**: claim creator fees, admin panel, moderation, exclusions, pause switches.
9. **Hardening**: reconciliation, alerts, tests green, load test of the payout batching, security checklist, `DEPLOY.md`.
10. **Mainnet**: only after the owner approves. Small-cap live test first.

## 14. Open decisions (use the default; log the choice in `docs/DECISIONS.md`)

| Decision | Default |
|---|---|
| Brand and domain | "Backflow", kept in config |
| Payout interval | 300s (UI reads config) |
| Minimum payout | $0.50, rolls over |
| Buyback threshold | 1 SOL per buyback, max 1% impact |
| Post-graduation coin-token harvest | 100% to holders, never sold |
| Post-graduation SOL harvest | 2/3 buyback, 1/3 platform |
| Duplicate tickers | blocked on Backflow |
| Vanity `…back` mint addresses | off for v1 |
| Should the creator's own wallet earn holder rewards? | yes, like any holder |
