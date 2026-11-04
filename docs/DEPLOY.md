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

## 3. App user, code and secrets

```bash
sudo adduser --disabled-password --gecos "" backflow
```

```bash
sudo mkdir -p /etc/backflow/keys && sudo chown -R backflow:backflow /etc/backflow && sudo chmod 700 /etc/backflow /etc/backflow/keys
```

As the `backflow` user:

```bash
git clone https://github.com/fourtisf/backflow.git ~/backflow && cd ~/backflow && pnpm install --frozen-lockfile
```

```bash
cp config/.env.example /etc/backflow/backflow.env && chmod 600 /etc/backflow/backflow.env
```

Edit `/etc/backflow/backflow.env`:
- `SOLANA_CLUSTER`, `RPC_URL`, `RPC_WS_URL` (Helius), `DATABASE_URL`, `REDIS_URL`, `PINATA_JWT`, `TREASURY_PUBKEY`, `ADMIN_WALLETS`, `TELEGRAM_*`.
- Set `DATA_MODE=live` and `CORS_ORIGINS=https://your.domain`.
- Set `NEXT_PUBLIC_API_URL=/api`, `NEXT_PUBLIC_WS_URL=wss://your.domain/live`, `NEXT_PUBLIC_SOLANA_CLUSTER` and `NEXT_PUBLIC_RPC_URL`.

Keys (hot wallets only; the platform admin is a Squads multisig on mainnet):

```bash
pnpm --filter @backflow/scripts keys:new -- --dir /etc/backflow/keys
```

Point the `*_KEYPAIR_PATH` variables at those files. Fund the buyback, distributor and platform-fee wallets with small working balances.

## 4. Platform, lookup table, migrations, build

The apps read `.env` at the repo root. Link it to the protected file:

```bash
ln -sf /etc/backflow/backflow.env ~/backflow/.env
```

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

Put `PLATFORM_CONFIG_PUBKEY`, `CP_CONFIG_ID` and `BACKFLOW_ALT` into the env file.

```bash
pnpm db:deploy
```

```bash
pnpm --filter @backflow/web build
```

## 5. Processes

```bash
pm2 start ecosystem.config.js && pm2 save
```

```bash
pm2 startup systemd -u backflow --hp /home/backflow
```

Run the command `pm2 startup` prints. Logs: `pm2 logs`, or `pm2 logs buyback --lines 200`. Worker health:

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

## 7. Nightly backups

```bash
sudo cp deploy/backup.sh /usr/local/bin/backflow-backup && sudo chmod 755 /usr/local/bin/backflow-backup
```

```bash
echo "17 3 * * * backflow /usr/local/bin/backflow-backup" | sudo tee /etc/cron.d/backflow-backup
```

Backups go to `/var/backups/backflow` (14 days kept). Copy them off the server too, for example with `rclone` to object storage.

Restore drill:

```bash
gunzip -c /var/backups/backflow/backflow-YYYYMMDD.sql.gz | psql "$DATABASE_URL"
```

## 8. Upgrades and rollback

```bash
cd ~/backflow && git pull && pnpm install --frozen-lockfile && pnpm db:deploy && pnpm --filter @backflow/web build && pm2 reload ecosystem.config.js
```

Workers recover in-flight transactions from the database on restart (they check stored signatures before doing anything). Rolling back is `git checkout <previous tag>` and the same command. Migrations only add columns; check before rolling back past one.

To stop money movement at once, use the admin page, or `pm2 stop buyback payout harvest reconcile`.
