# Authorities and keys

Every key or on-chain authority Backflow depends on (SPEC §9). Update this file whenever one changes.

**The platform admin can't be moved later.** The PlatformConfig PDA is derived from the admin key, so the mainnet platform must be created by the Squads multisig vault itself (`pnpm platform:create -- --squads <vault>`, see `MAINNET.md`). The devnet platform can use a plain keypair.

| Authority | What it controls | Holder (devnet) | Holder (mainnet target) | Hot? |
|---|---|---|---|---|
| Platform admin | Our LaunchLab `PlatformConfig` PDA (`["platform_config", admin]`). It can update fee rates, wallets, CPMM config and curve rules, one update per epoch. | `PLATFORM_ADMIN_KEYPAIR_PATH` | Squads multisig | No. Used only for `platform:create` and updates. |
| Platform claim-fee wallet (`platformClaimFeeWallet`) | Claims the shared platform fee vault (`claimVaultPlatformFee`). | `PLATFORM_FEE_WALLET_KEYPAIR_PATH` | Same, a dedicated hot key | Yes. Holds SOL only in transit. |
| Lock NFT wallet (`platformLockNftWallet`) | Receives the Fee Key NFT for each graduated pool and signs harvests (it must also pay the harvest fee; see DECISIONS D-004). | Defaults to the claim-fee wallet | Same hot key, or a separate harvest key | Yes |
| Platform vesting wallet | Platform vesting share. Unused. | `PublicKey.default` | unchanged | n/a |
| Transfer-fee extension auth | Token-2022 transfer-fee authority after migration. Unused, because we launch SPL Token mints. | Platform admin | Squads multisig | n/a |
| `platformCpCreator` | Would take CPMM creator fees. **Left unset** so the token creator keeps them (DECISIONS D-005). | unset | unset | n/a |
| Buyback wallet | Signs buybacks and holds buyback budgets (SOL). | `BUYBACK_WALLET_KEYPAIR_PATH` | Hot key, topped up from treasury | Yes |
| Distributor wallet | Receives bought-back tokens and signs payouts. Excluded from rewards. | `DISTRIBUTOR_WALLET_KEYPAIR_PATH` | Hot key | Yes |
| Treasury | Platform revenue. Refills the hot wallets. | `TREASURY_PUBKEY` (pubkey only) | Squads multisig | No |
| Admin commands | Hide coins, exclusions, pause/resume, approve held claims (`pnpm admin`). There is no admin page or admin API. | Shell access to the server (SSH key) plus `DATABASE_URL` | Owner and ops | n/a |
| Coin mint and freeze authority | Set by the LaunchLab program at initialize. **VERIFY** they are revoked (DECISIONS checklist). | LaunchLab | LaunchLab | n/a |
| Migrated LP | 100% locked through Burn & Earn (`platformScale` = 1,000,000). Not withdrawable; fees claimable with the Fee Key. | LaunchLab, then the lock program | same | n/a |

Rules:
- Keys are loaded from file paths in env at runtime. The repo ships only `config/.env.example`. Scripts refuse key paths inside the repo.
- `pnpm --filter @backflow/scripts keys:new -- --dir <dir outside repo>` generates the hot keys with mode 0600.
- Hot wallets hold only working balances, with low-balance alerts (Milestone 9).
