# Security checklist

Status of every item in SPEC §9 and CLAUDE.md, with where it is enforced. ✅ done · ⏳ needs devnet/mainnet verification or owner action.

## Funds and keys
- ✅ **No custody of user funds.** Users sign their own launches, trades and creator claims. The API only returns unsigned transactions (`apps/api/src/routes/actions.ts`). The one server-side signature is the new mint keypair's, which is generated per launch and discarded.
- ✅ **Separate hot keys** for the buyback signer, the distributor and the platform fee claimer. The treasury is a pubkey only. Keys are loaded from paths outside the repo, and scripts refuse paths inside it (`packages/chain/src/env.ts`).
- ✅ **Key isolation between processes** (`apps/api/src/server.ts`, `ecosystem.config.js`, `DEPLOY.md` §3).
  - The internet-facing API never loads a hot-wallet secret key. It reads `BUYBACK_PUBKEY`, `DISTRIBUTOR_PUBKEY` and `PLATFORM_FEE_PUBKEY`. Outside production only, it falls back to reading the keypair file, with a warning. Its one secret key is `VANITY_KEY` (vanity mints).
  - Each PM2 process reads a key-free `common.env` plus its own env file, which names only the key that process signs with. `PLATFORM_ADMIN_KEYPAIR_PATH` is in no PM2 env file.
  - The deploy guide runs every process as its own Unix user (`BACKFLOW_SPLIT_USERS=1`). Each key file is `chmod 400` and owned by the one user that signs with it, so the web and API users can't read any key. ⏳ The owner applies this on the VPS.
- ⏳ **Platform admin on a Squads multisig before mainnet.** The PlatformConfig PDA is derived from the admin key and can't be moved later, so the mainnet platform must be created by the multisig vault: `pnpm platform:create -- --squads <vault>` (see `MAINNET.md`).
- ✅ **Hot wallets hold working balances only**, with low-balance alerts (`reconcile` worker). ⏳ Automatic top-up from the treasury is deliberately manual for now: the treasury is a multisig.
- ✅ **No secrets in git.** `.gitignore` covers `.env*`, `keys/` and `*.keypair.json`; the repo ships `config/.env.example` only.

## Transactions
- ✅ **Every buyback, payout, claim and harvest is a database row** that moves pending → sent → confirmed/failed. The signature is stored before broadcasting.
- ✅ **No retry without checking the previous attempt.** In-flight rows are resolved from their signature status and blockhash expiry on every tick (`recoverInflight`, `recoverPayouts`, `recoverClaims`, `recoverHarvests`).
  - An error counts only once it is `confirmed`.
  - "Dropped" needs the *finalized* height to be 20 blocks past the blockhash.
  - A landed transaction whose effects can't be read yet is never settled as zero (D-037).
- ✅ **Idempotency keys:** `Buyback.idempotencyKey = mint:round:chunk`, `Payout.idempotencyKey = mint:round`, `PayoutItem (payoutId, wallet)`, `Trade (signature, eventIndex)`, `BalanceEvent (signature, mint, wallet)`.
- ✅ **One process per worker.** Each worker must hold a lease row (`WorkerLease`, 30 s, renewed every 10 s), so two copies can't double-spend. A lost lease stops new ticks. A waiting copy retries, so `pm2 reload` hands over cleanly (D-035).
- ✅ **Simulate before sending** (`packages/chain/src/send.ts`). Priority fees come from `PRIORITY_FEE_MICROLAMPORTS`.
- ✅ **Slippage bounds from quotes.** Users choose 0.5–5% in the trade panel. Buybacks use `minOut` = quote − the impact cap, and each chunk is capped at 1% price impact by an exact binary search on the curve math.
- ✅ **Reconciliation:** vault claims must match accrued platform fees within 0.5%; otherwise buybacks pause and an alert fires. Held claims need an admin's approval.
- ✅ **Workers never claim while the indexer is behind.** A landed claim is matched to accruals only after the platform stream has passed it, so accruals and claims cover the same trades (D-033).
- ✅ **Money invariants**, checked by the `reconcile` worker:
  - the distributor holds at least what is owed to each coin's holders;
  - the buyback wallet holds at least the funded budgets.

  Chain balances are read before the DB snapshot. A shortfall must show on two checks in a row before it pauses that coin's payouts or all buybacks, and it alerts (D-029).
- ✅ **Jupiter buybacks (optional) never blind-sign.** Instructions are allowlisted and compiled locally, then simulated with balance checks (D-028).

## Indexer trust model
- ✅ **Only LaunchLab's own self-CPI events are read.** "Program data:" log lines are ignored, because any program can write them (D-032).
- ✅ **Nothing is skipped silently.**
  - Signature backlogs are paged back to the cursor.
  - A signature the RPC can't return yet stops its stream without moving the cursor.
  - A transaction that keeps failing to apply is recorded as a dead letter with an alert (D-022).
- ✅ **Balances are checked against chain before money moves.** Holders are resynced from every token account of the mint before each buyback credit and each payout, and whenever a balance would go negative. Wallets whose recorded balance was too high earn nothing from that window and are flagged for forfeiture. Payouts use `TransferChecked` so they're visible to the indexer (D-031).
- ✅ **Coins launched from other frontends are untrusted input** (D-036).
  - Their metadata is fetched outside DB transactions, over https or IPFS only, with private addresses refused at connect time, a 6 s total deadline and a 64 KB cap.
  - It is validated before storage.
  - Lookalike tickers and Token-2022 mints are hidden pending review.

## API and web
- ✅ **Rate limits per client address** (`apps/api/src/app.ts`, `apps/api/src/net.ts`, the routes).
  - The API listens on 127.0.0.1 and trusts `X-Forwarded-For` only from `TRUST_PROXY` (default 127.0.0.1). Nginx overwrites that header with the real address, so a client can't pick its own bucket. IPv6 clients share one bucket per /64.
  - Global: 600 requests per minute.
  - Uploads: 10 per hour per address, and 10 per hour per wallet.
  - Launch transactions: 20 per hour. Launch sessions: 20 per hour. Sign-in nonces: 30 per minute.
  - Trade transactions: 60 per minute. Creator claim transactions: 30 per minute.
  - Reports: 5 per hour.
  - Nginx, per address: 20 requests per second with a burst of 40 on `/api/`, 10 uploads per minute, and on `/live` 20 open connections and 30 new ones per minute.
- ✅ **WebSocket `/live`.** Connections are capped in total and per client (`WS_MAX_CONNECTIONS`, `WS_MAX_PER_IP`). The hello message comes from a 3 s stats cache. Each event is serialized once for all sockets. Sockets that miss two pongs are closed. An unhandled promise rejection is logged and doesn't stop the API.
- ✅ **Upload validation** (`apps/api/src/ipfs.ts`).
  - An upload needs a signed launch session.
  - The type is read from the file's first bytes. Only PNG, JPEG, GIF and WebP reach the image library; SVG, TIFF, HEIF and the rest are refused before any decoder runs.
  - Up to 4 MB, 32–4096 px per frame, at most 60 frames, and at most 25 million pixels across all frames (also passed to libvips as its pixel limit).
  - Processing has a 5 s timeout, and only one image is processed at a time.
  - Re-encoding with sharp strips EXIF, GPS and XMP. Tests cover EXIF stripping, type sniffing, and the frame and pixel caps.
- ✅ **Signed messages use single-use server nonces** (`apps/api/src/auth.ts`, `packages/core/src/signin.ts`): launch and Telegram linking. The message names the site (`AUTH_DOMAIN`), the cluster, the purpose, the nonce and the time it was issued. The API rebuilds it from its own settings, so a signature made for another site, cluster or purpose fails. A nonce is valid 5 minutes and is used up atomically on first use.
- ✅ **A ticker can only be reserved by a wallet that is really launching** (`apps/api/src/routes/actions.ts`).
  - `/launch/tx` needs a launch session (15 minutes; only its sha256 is stored).
  - The metadata URI must be one that `/launch/metadata` pinned for the same wallet and ticker (`MetadataPin`). So "launched via Backflow" also means "metadata pinned by Backflow".
  - The wallet must hold the first buy plus about 0.03 SOL for launch accounts and fees. If the balance can't be read, the launch is refused.
  - One active reservation per wallet. The check and the insert run under a per-ticker advisory lock, so two wallets can't both reserve a ticker. Reservations that expired more than an hour ago are deleted.
- ✅ **No admin door on the internet.** There is no admin page and no admin API (owner decision, D-041). Admin tasks run as `pnpm admin <command>` on the server, which needs SSH access and the database credentials.
  - Resuming buybacks or payouts, approving a held claim and resolving a dead letter need `--yes`.
  - Every admin write is logged in `JobLog` as `cli:<user>@<host>`, in the same database transaction as the change (`packages/db/src/admin.ts`). `pnpm admin log` shows them.
- ✅ **Input handling.** A repeated query key keeps its first value. POST bodies have JSON schemas with length limits, and the body limit is 64 KB. Route parameters that should be addresses are checked. 5xx answers carry a generic message, and details go to the log only. Chain and builder errors map to fixed messages.
- ✅ **Heavy public reads are cached:** `/stats` 3 s, `/stats/platform` 15 s, `/coins/:mint/risk` 15 s, `/status` 10 s. Holder risk uses bounded queries.
- ✅ **Public status** shows only ok or down per component, plus indexer lag in seconds. Worker notes stay on the server (`pnpm admin overview`). `/health` and `/status` report degraded in live mode while the address lookup table isn't loaded. The API keeps retrying the load.
- ✅ **Reports.** The reporter is a salted daily hash of the client address; an unsigned `wallet` field is ignored. One report per reporter per coin, and the admin list counts distinct reporters.
- ✅ **The web checks every server-built transaction before the wallet sees it** (`packages/chain/src/verify.ts`, called in `apps/web/src/lib/tx.ts`).
  - The fee payer must be the connected wallet.
  - Programs: ComputeBudget, System, SPL Token, Associated Token, and the cluster's LaunchLab and CPMM programs only.
  - No Approve, SetAuthority or token Transfer. CloseAccount must pay out to the user. SOL transfers may only go into the user's own wSOL account. Token accounts may only be created for the user. The priority fee is capped.
  - ⏳ LaunchLab and CPMM amounts and `minOut` are not decoded and compared with the quote. The wallet's own simulation shows them.
- ✅ **CORS closed by default**; only `CORS_ORIGINS` may call from a browser.
- ✅ **Security headers.** The web sends CSP, X-Frame-Options DENY, nosniff, Referrer-Policy and Permissions-Policy. The API sends nosniff and no-referrer. Nginx sends HSTS (one year, including subdomains).
  - `connect-src` allows only the site, the API and its WebSocket origin, the Solana RPC origin, and Plausible when it's enabled. localhost is allowed in development only.
  - `img-src` allows only the site, `data:`, `blob:` and the IPFS gateway (`NEXT_PUBLIC_IPFS_GATEWAY`).
  - ⏳ `script-src` still has `'unsafe-inline'`. Next 14 needs inline scripts for hydration, and there is no nonce middleware, so the CSP does **not** stop an injected inline script or event handler. XSS protection rests on React escaping text and on the link and image rules below. Next step: a nonce-based CSP with `'strict-dynamic'` through middleware.
- ✅ **Untrusted coin metadata** (links and images). Coins launched from any frontend are covered, not only metadata Backflow pinned.
  - Links are normalized to https and host-checked when the API pins metadata, when the indexer stores it (D-036), when the API serves a coin (`packages/db/src/dto.ts`), and again when the coin page renders (`safeHref`). X links must point at x.com or twitter.com, and Telegram links at t.me or telegram.me. Anything else isn't shown. Links open with `rel="noopener noreferrer nofollow"`.
  - Coin images load only from our IPFS gateway. IPFS references are rewritten to it; any other image shows the generated avatar.
- ✅ **Mock mode** keeps at most 2,000 simulated wallets in memory.
- ✅ **Footer disclaimer and Terms page.** ⏳ Terms is a draft that needs legal review.

## Before mainnet (owner)
- ⏳ All on-chain VERIFY items in `DECISIONS.md` checked with `pnpm platform:show` and a devnet end-to-end run (`pnpm sim`).
- ⏳ An independent review of `apps/workers` (money movement) and `packages/chain/src/tx.ts`. Backflow has no custom on-chain program; the risk sits in these off-chain workers.
- ⏳ Legal review of the reward model and the Terms page in the jurisdictions you serve.
- ⏳ A Telegram alert channel tested end to end.
- ⏳ A restore drill from a nightly backup.
