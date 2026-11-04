# Security checklist

Status of every item in SPEC §9 and CLAUDE.md, with where it is enforced. ✅ done · ⏳ needs devnet/mainnet verification or owner action.

## Funds and keys
- ✅ **No custody of user funds.** Users sign their own launches, trades and creator claims. The API only returns unsigned transactions (`apps/api/src/routes/actions.ts`). The one server-side signature is the new mint keypair's, which is generated per launch and discarded.
- ✅ **Separate hot keys** for the buyback signer, the distributor and the platform fee claimer. The treasury is a pubkey only. Keys are loaded from paths outside the repo, and scripts refuse paths inside it (`packages/chain/src/env.ts`).
- ⏳ **Platform admin on a Squads multisig before mainnet.** The PlatformConfig PDA is derived from the admin key and can't be moved later, so the mainnet platform must be created by the multisig vault: `pnpm platform:create -- --squads <vault>` (see `MAINNET.md`).
- ✅ **Hot wallets hold working balances only**, with low-balance alerts (`reconcile` worker). ⏳ Automatic top-up from the treasury is deliberately manual for now: the treasury is a multisig.
- ✅ **No secrets in git.** `.gitignore` covers `.env*`, `keys/` and `*.keypair.json`; the repo ships `config/.env.example` only.

## Transactions
- ✅ **Every buyback, payout, claim and harvest is a database row** that moves pending → sent → confirmed/failed. The signature is stored before broadcasting.
- ✅ **No retry without checking the previous attempt.** In-flight rows are resolved from their signature status and blockhash expiry on every tick (`recoverInflight`, `recoverPayouts`, `recoverClaims`, `recoverHarvests`).
- ✅ **Idempotency keys:** `Buyback.idempotencyKey = mint:round:chunk`, `Payout.idempotencyKey = mint:round`, `PayoutItem (payoutId, wallet)`, `Trade (signature, eventIndex)`, `BalanceEvent (signature, mint, wallet)`.
- ✅ **One process per worker**, enforced with a Postgres advisory lock, so two copies can't double-spend.
- ✅ **Simulate before sending** (`packages/chain/src/send.ts`). Priority fees come from `PRIORITY_FEE_MICROLAMPORTS`.
- ✅ **Slippage bounds from quotes.** Users choose 0.5–5% in the trade panel. Buybacks use `minOut` = quote − the impact cap, and each chunk is capped at 1% price impact by an exact binary search on the curve math.
- ✅ **Reconciliation:** vault claims must match accrued platform fees within 0.5%; otherwise buybacks pause and an alert fires. Held claims need an admin's approval.
- ✅ **Workers never claim while the indexer is behind**, so accruals and claims cover the same trades.

## API and web
- ✅ **Rate limits:**
  - global: 600 requests per minute per IP;
  - upload: 10 per hour;
  - launch: 20 per hour;
  - trade transactions: 60 per minute;
  - Nginx: 20 requests per second with a burst of 40.
- ✅ **Upload validation:** MIME type, 4 MB size, dimensions 32–4096 px, decodable image. Re-encoding with sharp strips EXIF/GPS/XMP; there is a test for this.
- ✅ **Admin auth:** wallet allowlist plus an ed25519 signature over a dated message, valid 15 minutes. Every admin write is logged in `JobLog` with the wallet.
- ✅ **CORS closed by default**; only `CORS_ORIGINS` may call from a browser.
- ✅ **Security headers:** CSP, X-Frame-Options DENY, nosniff, Referrer-Policy and Permissions-Policy on the web; nosniff and no-referrer on the API; HSTS-capable TLS through Nginx.
- ✅ **Untrusted links** (X, Telegram, website) are normalized to https and host-checked before being stored in metadata, and rendered with `rel="noreferrer nofollow"`.
- ✅ **Footer disclaimer and Terms page.** ⏳ Terms is a draft that needs legal review.

## Before mainnet (owner)
- ⏳ All on-chain VERIFY items in `DECISIONS.md` checked with `pnpm platform:show` and a devnet end-to-end run (`pnpm sim`).
- ⏳ An independent review of `apps/workers` (money movement) and `packages/chain/src/tx.ts`. Backflow has no custom on-chain program; the risk sits in these off-chain workers.
- ⏳ Legal review of the reward model and the Terms page in the jurisdictions you serve.
- ⏳ A Telegram alert channel tested end to end.
- ⏳ A restore drill from a nightly backup.
