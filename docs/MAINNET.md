# Mainnet runbook

**Nothing in this file runs without the owner's explicit approval in chat** (CLAUDE.md rule 2). Scripts refuse mainnet unless `BACKFLOW_MAINNET_APPROVED=owner-approved-mainnet` is set for that one command.

## 0. Preconditions (all must be true)

1. **Devnet end to end.**
   - The platform has been created on devnet.
   - `pnpm sim -- --launch --trades 200` shows trades indexed, buyback rounds firing in chunks, credits, payouts landing, forfeiture on a sell, and a graduation.
   - A harvest has run on a graduated devnet pool.
   - A vault claim has reconciled within 0.5%.
2. **Every on-chain VERIFY item is ticked in `docs/DECISIONS.md`**, with `pnpm platform:show` output as evidence:
   - the protocol fee is 0.25% (otherwise the owner decides how to handle the 1.1% promise);
   - the curve floors pass;
   - mint and freeze authority are revoked;
   - the CPMM tier is chosen;
   - the TradeEvent layout is confirmed on a live transaction;
   - the buyback can deliver tokens directly to the distributor (DECISIONS D-017);
   - `platformCpCreator` unset means "token creator".
   - every item under "Still to confirm on devnet (from the November audit)" in `docs/DECISIONS.md`, notably:
     - a real migration graduates the coin in the DB;
     - a holder sync (`getProgramAccounts` with a mint filter) completes quickly on the production RPC;
     - an invisible plain `Transfer` between two devnet wallets is caught by the sync before the next credit.
3. **Security checklist** (`docs/SECURITY.md`) is complete, including the independent review and the legal review.
4. **Squads multisig** exists for the platform admin and the treasury, with at least 2 of 3 signers on separate devices.

## 1. Keys and wallets

1. Create a Squads vault for the platform admin, and one for the treasury (or reuse a single vault).
2. On the VPS, generate the hot keys:

   ```bash
   pnpm --filter @backflow/scripts keys:new -- --dir /etc/backflow/keys
   ```

3. Record every address in `docs/AUTHORITIES.md`.
4. Fund the hot wallets with small amounts:
   - buyback: about 0.2 SOL, refilled by vault claims;
   - distributor: about 0.1 SOL for fees;
   - platform fee wallet: about 0.1 SOL for claims and harvests.

## 2. Create the mainnet platform through Squads

The PlatformConfig PDA is derived from the admin key and can never be moved, so the multisig itself must create it.

```bash
SOLANA_CLUSTER=mainnet-beta BACKFLOW_MAINNET_APPROVED=owner-approved-mainnet pnpm platform:create -- --squads <SQUADS_VAULT_ADDRESS>
```

The script reads the live GlobalConfig, checks the protocol fee and curve floors, lists the CPMM tiers, and prints an unsigned transaction. Import it in Squads (Developers → TX builder), check every field against `config/fees.json`, approve and execute. Then:

```bash
SOLANA_CLUSTER=mainnet-beta pnpm platform:show
```

Set `PLATFORM_CONFIG_PUBKEY` and `CP_CONFIG_ID` in `/etc/backflow/common.env` (shared settings; each process also reads its own `<name>.env`, see `DEPLOY.md`). Then create the lookup table (payer: the platform fee wallet):

```bash
SOLANA_CLUSTER=mainnet-beta BACKFLOW_MAINNET_APPROVED=owner-approved-mainnet pnpm alt:create -- --send
```

## 3. Switch the deployment to mainnet

In the env file:
- `SOLANA_CLUSTER=mainnet-beta` and `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta`;
- mainnet Helius `RPC_URL`/`RPC_WS_URL`, and a public `NEXT_PUBLIC_RPC_URL` with your Helius key restricted by domain;
- `DATA_MODE=live`, `BACKFLOW_MAINNET_APPROVED=owner-approved-mainnet` (workers and the API need it to sign on mainnet), `PRIORITY_FEE_MICROLAMPORTS` (start at about 50,000).

Start with buybacks and payouts paused: run `pnpm admin pause buybacks` and `pnpm admin pause payouts` right after starting.

```bash
pnpm db:deploy && pnpm --filter @backflow/web build && pm2 reload ecosystem.config.js
```

## 4. Small-cap live test

1. Launch one coin through the site with a small first buy (≤ 0.1 SOL).
2. Watch it appear on the board. Check the fee rows on the coin page and `pnpm admin overview` (indexer not stuck, slot advancing).
3. Make a few small trades from two wallets.
4. Resume reconcile only: wait for a vault claim, check that it reconciled and that the buyback wallet received Σ holdersPart.
5. Resume buybacks. Watch one round (chunked, ≤ 1% impact each) and the credits on the Rewards page.
6. Resume payouts. Watch one payout land. Sell from one wallet and confirm its pending is forfeited at the next payout.

## 5. Operating

- **Pause:** `pnpm admin pause buybacks|payouts` (add `--coin <mint>` for one coin). The workers finish in-flight transactions and then stop new ones.
- **Reconciliation mismatch:** buybacks pause automatically. Investigate it with `pnpm admin claims`, approve it with `pnpm admin approve-claim <id> --yes` if it is understood, then `pnpm admin resume buybacks --yes`.
- **Alerts:** Telegram covers reconciliation mismatch, low hot-wallet balance, failed payouts above `ALERT_FAILED_PAYOUTS`, indexer lag, and repeated buyback failures.
- **Fee changes** go through Squads with `updatePlatformConfig`, at most once per epoch. Update `config/fees.json` in the same release.
