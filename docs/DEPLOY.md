# Deploying Backflow to a VPS

A single Hostinger VPS (Ubuntu 24.04 LTS) runs everything: Nginx (TLS) → Next.js web and the Fastify API, the five workers under PM2, PostgreSQL 16 and Redis 7 (SPEC §12).

Mainnet needs the owner's explicit approval first. Run this on devnet before anything else, and follow [`MAINNET.md`](MAINNET.md) for go-live.

## 1. Server packages

```bash
sudo apt update && sudo apt -y upgrade
```

```bash
sudo apt -y install nginx postgresql-16 redis-server git build-essential certbot python3-certbot-nginx ufw
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt -y install nodejs
```

```bash
sudo npm i -g pnpm@10.28.0 pm2
```

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

Redis should listen on localhost only (Ubuntu's default). Check `bind 127.0.0.1 -::1` in `/etc/redis/redis.conf`.

## 2. Database

```bash
sudo -u postgres psql -c "CREATE ROLE backflow LOGIN PASSWORD 'CHANGE-ME';"
```

```bash
sudo -u postgres psql -c "CREATE DATABASE backflow OWNER backflow;"
```

## 3. Users, code, env files and keys

Every process runs as its own Unix user, and each hot key is readable only by the process that signs with it (SECURITY.md, "Key isolation").

| User | Runs | Key it can read |
|---|---|---|
| `backflow` | owns the code and builds it; runs `web` (Next writes its cache under `.next/`) | none |
| `bf-api` | `api` | none (only `VANITY_KEY`, in `api.env`) |
| `bf-indexer` | `indexer` | none |
| `bf-buyback` | `buyback` | `buyback.json` |
| `bf-payout` | `payout` | `distributor.json` |
| `bf-fee` | `harvest`, `reconcile` | `platform-fee.json` |

```bash
sudo adduser --disabled-password --gecos "" backflow
```

```bash
for u in bf-api bf-indexer bf-buyback bf-payout bf-fee; do sudo adduser --system --group --no-create-home "$u"; done
```

Operator commands (migrations, `platform:create`, `alt:create`) run as root, see below. As the `backflow` user, get the code (the other users only need to read it):

```bash
git clone https://github.com/fourtisf/backflow.git ~/backflow && cd ~/backflow && pnpm install --frozen-lockfile && chmod 755 ~
```

### Env files

Each process reads `/etc/backflow/common.env` plus its own `/etc/backflow/<name>.env` (`ecosystem.config.js`; the later file wins). The web reads only `web.env`.

```bash
sudo mkdir -p /etc/backflow/keys && sudo chown root:root /etc/backflow && sudo chmod 755 /etc/backflow
```

```bash
sudo groupadd -f bf-env && for u in bf-api bf-indexer bf-buyback bf-payout bf-fee; do sudo usermod -aG bf-env "$u"; done
```

Start every file from `config/.env.example` and keep only the keys listed for it:

- `common.env` (root:bf-env, 640): `SOLANA_CLUSTER`, `RPC_URL`, `RPC_WS_URL`, `DATABASE_URL`, `REDIS_URL`, `PLATFORM_CONFIG_PUBKEY`, `GLOBAL_CONFIG_PUBKEY`, `CP_CONFIG_ID`, `BACKFLOW_ALT`, `TREASURY_PUBKEY`, `BUYBACK_PUBKEY`, `DISTRIBUTOR_PUBKEY`, `PLATFORM_FEE_PUBKEY`, `PRIORITY_FEE_MICROLAMPORTS`, `SOL_USD_SOURCE`, `PINATA_GATEWAY`, `TELEGRAM_ALERT_*`, the worker timings and `WORKER_*_PORT`, `LOG_LEVEL`. No keypair paths.
- `api.env` (root:bf-api, 640): `DATA_MODE=live`, `API_HOST=127.0.0.1`, `TRUST_PROXY=127.0.0.1`, `CORS_ORIGINS=https://your.domain`, `PUBLIC_SITE_URL=https://your.domain`, `AUTH_DOMAIN=your.domain`, `PINATA_JWT`, `HELIUS_WEBHOOK_SECRET`, `TELEGRAM_BOT_*`, `VANITY_ENABLED`/`VANITY_KEY` if used, `WS_MAX_*`.
- `web.env` (root:backflow, 644; it holds no secrets): `NEXT_PUBLIC_API_URL=/api`, `NEXT_PUBLIC_WS_URL=wss://your.domain/live`, `NEXT_PUBLIC_SOLANA_CLUSTER`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_IPFS_GATEWAY`, `API_INTERNAL_URL=http://127.0.0.1:4000`.
- `buyback.env` (root:bf-buyback, 640): `BUYBACK_WALLET_KEYPAIR_PATH=/etc/backflow/keys/buyback.json`.
- `payout.env` (root:bf-payout, 640): `DISTRIBUTOR_WALLET_KEYPAIR_PATH=/etc/backflow/keys/distributor.json`.
- `harvest.env` and `reconcile.env` (root:bf-fee, 640): `PLATFORM_FEE_WALLET_KEYPAIR_PATH=/etc/backflow/keys/platform-fee.json`.
- `indexer.env` (root:bf-indexer, 640): worker-only settings, or empty. It must exist.
- `scripts.env` (root only, 600): what operator commands need on top of `common.env`, for example `PLATFORM_ADMIN_KEYPAIR_PATH` on devnet. It is never given to a PM2 process.

```bash
sudo touch /etc/backflow/indexer.env
```

```bash
sudo chown root:bf-env /etc/backflow/common.env && sudo chmod 640 /etc/backflow/common.env
```

```bash
for n in api:bf-api buyback:bf-buyback payout:bf-payout harvest:bf-fee reconcile:bf-fee indexer:bf-indexer; do sudo chown "root:${n#*:}" "/etc/backflow/${n%%:*}.env" && sudo chmod 640 "/etc/backflow/${n%%:*}.env"; done
```

```bash
sudo chown root:backflow /etc/backflow/web.env && sudo chmod 644 /etc/backflow/web.env && sudo chmod 600 /etc/backflow/scripts.env
```

`next build` reads `NEXT_PUBLIC_*` from the repo-root `.env`. Point it at `web.env`, which holds no secrets:

```bash
ln -sf /etc/backflow/web.env ~/backflow/.env
```

Operator commands (migrations, `platform:create`, `alt:create`, `sim`) run as root with the env loaded into the shell, so they never need a key in a shared file. Values in the env files must not contain spaces or `&` for this.

```bash
sudo sh -c 'set -a; . /etc/backflow/common.env; . /etc/backflow/scripts.env; set +a; cd /home/backflow/backflow && pnpm db:deploy'
```

### Keys

Hot wallets only; the platform admin is a Squads multisig on mainnet.

```bash
cd /home/backflow/backflow && sudo pnpm --filter @backflow/scripts keys:new -- --dir /etc/backflow/keys
```

It prints each wallet's public key; you need them below. `platform-admin.json` stays owned by root and is used only by operator commands on devnet.

Give each key to its one user, readable by nobody else:

```bash
sudo chown bf-buyback /etc/backflow/keys/buyback.json && sudo chown bf-payout /etc/backflow/keys/distributor.json && sudo chown bf-fee /etc/backflow/keys/platform-fee.json
```

```bash
sudo chmod 400 /etc/backflow/keys/*.json && sudo chmod 711 /etc/backflow/keys
```

The directory is `711`: a user can open a file it already knows the name of and owns, but can't list the directory. `backflow` (web) and `bf-api` own no key file, so they can read none.

Put each wallet's public key in `common.env` (`BUYBACK_PUBKEY`, `DISTRIBUTOR_PUBKEY`, `PLATFORM_FEE_PUBKEY`). The API only reads these; in production it never opens a keypair file. Workers check that a key file they sign with matches its public key.

Fund the buyback, distributor and platform-fee wallets with small working balances.

Check that the isolation holds (each command should print "Permission denied"):

```bash
sudo -u bf-api cat /etc/backflow/keys/buyback.json; sudo -u backflow cat /etc/backflow/common.env; sudo -u bf-payout cat /etc/backflow/keys/buyback.json
```

## 4. Platform, lookup table, migrations, build

Use the operator form from §3 (`sudo sh -c 'set -a; . …common.env; . …scripts.env; set +a; cd … && <command>'`) for each command here except the web build.

```bash
pnpm platform:create
```

Review the dry run (protocol fee check, curve floors, CPMM tier), then:

```bash
pnpm platform:create -- --send
```

```bash
pnpm alt:create -- --send
```

Put `PLATFORM_CONFIG_PUBKEY`, `CP_CONFIG_ID` and `BACKFLOW_ALT` into `common.env`. Until `BACKFLOW_ALT` loads, the API's `/health` and `/status` say "degraded".

```bash
pnpm db:deploy
```

As `backflow`:

```bash
pnpm --filter @backflow/web build
```

## 5. Processes

PM2 runs as root so it can start each process as its own user (`uid`/`gid` in `ecosystem.config.js`, enabled by `BACKFLOW_SPLIT_USERS=1`). The web listens on 127.0.0.1:3000 and the API on 127.0.0.1:4000; only Nginx is reachable from outside.

```bash
cd /home/backflow/backflow && sudo BACKFLOW_SPLIT_USERS=1 pm2 start ecosystem.config.js && sudo pm2 save
```

```bash
sudo pm2 startup systemd
```

Run the command `pm2 startup` prints. Logs: `sudo pm2 logs`, or `sudo pm2 logs buyback --lines 200`. Check that each process runs as its user:

```bash
ps -o user,cmd -C node
```

Worker health:

```bash
for p in 4101 4102 4103 4104 4105; do curl -s localhost:$p/health; echo; done
```

## 6. Nginx and TLS

```bash
sudo cp deploy/nginx/backflow.conf /etc/nginx/sites-available/backflow
```

Replace `backflow.example` with your domain in that file, then:

```bash
sudo ln -sf /etc/nginx/sites-available/backflow /etc/nginx/sites-enabled/backflow && sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot --nginx -d your.domain
```

What the sample does:
- It overwrites `X-Forwarded-For` with `$remote_addr` in every location, and the API trusts that header only from 127.0.0.1 (`TRUST_PROXY`). Don't change it to `$proxy_add_x_forwarded_for`: clients could then choose their own rate-limit bucket.
- Rate limits per address: 20 requests per second on `/api/`, 10 uploads per minute on `/api/launch/metadata` (5 MB body there, 64 KB elsewhere), and 20 open plus 30 new WebSocket connections per minute on `/live`.
- It sends HSTS for one year, including subdomains. Only keep `includeSubDomains` if every subdomain serves https.

## 7. Nightly backups

```bash
sudo cp deploy/backup.sh /usr/local/bin/backflow-backup && sudo chmod 755 /usr/local/bin/backflow-backup
```

```bash
echo "17 3 * * * root /usr/local/bin/backflow-backup" | sudo tee /etc/cron.d/backflow-backup
```

Backups go to `/var/backups/backflow` (14 days kept). Copy them off the server too, for example with `rclone` to object storage.

Restore drill:

```bash
gunzip -c /var/backups/backflow/backflow-YYYYMMDD.sql.gz | psql "$DATABASE_URL"
```

## 8. Upgrades and rollback

As `backflow`:

```bash
cd ~/backflow && git pull && pnpm install --frozen-lockfile && pnpm --filter @backflow/web build
```

Then migrate and reload:

```bash
sudo sh -c 'set -a; . /etc/backflow/common.env; set +a; cd /home/backflow/backflow && pnpm db:deploy' && cd /home/backflow/backflow && sudo BACKFLOW_SPLIT_USERS=1 pm2 reload ecosystem.config.js
```

Workers recover in-flight transactions from the database on restart (they check stored signatures before doing anything). Rolling back is `git checkout <previous tag>` and the same command. Migrations only add columns; check before rolling back past one.

To stop money movement at once: `pnpm admin pause buybacks` and `pnpm admin pause payouts` (run as a user that can read `common.env`), or `sudo pm2 stop buyback payout harvest reconcile`.
