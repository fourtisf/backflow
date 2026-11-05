#!/bin/bash
# Mainnet phase 1: prepare the VPS. Sends NO transactions and spends no SOL (docs/MAINNET.md, D-043).
#   sudo bash /opt/backflow/deploy/mainnet-1-prepare.sh
# Sets up PostgreSQL and Redis, one Unix user per worker, the hot wallet keys and the live env files in
# /etc/backflow-live (the running demo keeps /etc/backflow until the switch), runs the migrations, then a
# read-only `platform:create` dry run on mainnet. Safe to run again: keys and the database are kept.
# Secrets are typed at hidden prompts on the server and written only to root-owned env files.
set -euo pipefail
APP=${APP:-/opt/backflow}
LIVE=${LIVE:-/etc/backflow-live}
KEYS=${KEYS:-/etc/backflow/keys}
DBFILE=${DBFILE:-/root/rebuy-db.txt}
SKIP_SYSTEM=${SKIP_SYSTEM:-0}
SKIP_PULL=${SKIP_PULL:-0}
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
[ -d "$APP" ] || { echo "No code at $APP"; exit 1; }

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

say "1/7 Latest code"
if [ "$SKIP_PULL" != 1 ]; then
  sudo -u backflow -H bash -c "cd $APP && git pull -q && pnpm install --frozen-lockfile --silent" || { echo "Updating the code failed (see the error above)"; exit 1; }
fi
git -C "$APP" log -1 --format='code at %h  %s' 2>/dev/null || true

if [ "$SKIP_SYSTEM" != 1 ]; then
  say "2/7 PostgreSQL and Redis"
  apt-get update -q >/dev/null
  apt-get install -y -q postgresql redis-server >/dev/null
  systemctl enable --now postgresql redis-server >/dev/null 2>&1 || true
fi
if [ ! -s "$DBFILE" ]; then
  DBPW=$(openssl rand -hex 16)
  if [ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='backflow'")" = 1 ]; then
    sudo -u postgres psql -qc "ALTER ROLE backflow LOGIN PASSWORD '$DBPW';"
  else
    sudo -u postgres psql -qc "CREATE ROLE backflow LOGIN PASSWORD '$DBPW';"
  fi
  [ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='backflow'")" = 1 ] || sudo -u postgres psql -qc "CREATE DATABASE backflow OWNER backflow;"
  echo "postgresql://backflow:$DBPW@127.0.0.1:5432/backflow" > "$DBFILE"
  chmod 600 "$DBFILE"
fi
DATABASE_URL=$(cat "$DBFILE")
echo "database ready (password saved in $DBFILE, root only)"

say "3/7 One user per process"
for u in bf-api bf-indexer bf-buyback bf-payout bf-fee; do id "$u" >/dev/null 2>&1 || adduser --system --group --no-create-home "$u" >/dev/null; done
groupadd -f bf-env
for u in bf-api bf-indexer bf-buyback bf-payout bf-fee; do usermod -aG bf-env "$u"; done
echo "users: bf-api bf-indexer bf-buyback bf-payout bf-fee"

say "4/7 Hot wallet keys (existing ones are kept)"
(cd "$APP" && pnpm --silent --filter @backflow/scripts keys:new -- --dir "$KEYS")
pub() { (cd "$APP/packages/chain" && node -e "const {Keypair}=require('@solana/web3.js');console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')))).publicKey.toBase58())" "$1"); }
ADMIN=$(pub "$KEYS/platform-admin.json"); FEE=$(pub "$KEYS/platform-fee.json"); BUY=$(pub "$KEYS/buyback.json"); DIST=$(pub "$KEYS/distributor.json")

say "5/7 Live settings (typed values are hidden; nothing is sent anywhere)"
read -rsp "Helius API key for the server: " HELIUS; echo
read -rsp "Helius API key for the browser (restricted to rebuy.fun): " HELIUS_WEB; echo
read -rsp "Pinata JWT: " PINATA; echo
read -rp  "Treasury wallet address (receives the platform's share): " TREASURY
read -rp  "Telegram alert bot token (Enter to skip): " TGTOKEN
read -rp  "Telegram alert chat id (Enter to skip): " TGCHAT
# accept a pasted Helius URL as well as the bare key
HELIUS=${HELIUS##*api-key=}; HELIUS=${HELIUS%%&*}; HELIUS_WEB=${HELIUS_WEB##*api-key=}; HELIUS_WEB=${HELIUS_WEB%%&*}
for v in HELIUS HELIUS_WEB PINATA TREASURY; do [ -n "${!v}" ] || { echo "$v is empty, run the script again"; exit 1; }; done
[[ "$TREASURY" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "That treasury address doesn't look like a Solana address"; exit 1; }

mkdir -p "$LIVE"
cat > "$LIVE/common.env" <<EOF
NODE_ENV=production
SOLANA_CLUSTER=mainnet-beta
BACKFLOW_MAINNET_APPROVED=owner-approved-mainnet
RPC_URL=https://mainnet.helius-rpc.com/?api-key=$HELIUS
RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=$HELIUS
DATABASE_URL=$DATABASE_URL
REDIS_URL=redis://127.0.0.1:6379
TREASURY_PUBKEY=$TREASURY
BUYBACK_PUBKEY=$BUY
DISTRIBUTOR_PUBKEY=$DIST
PLATFORM_FEE_PUBKEY=$FEE
PRIORITY_FEE_MICROLAMPORTS=50000
SOL_USD_SOURCE=pyth
PINATA_GATEWAY=https://gateway.pinata.cloud/ipfs/
TELEGRAM_ALERT_BOT_TOKEN=$TGTOKEN
TELEGRAM_ALERT_CHAT_ID=$TGCHAT
LOG_LEVEL=info
EOF
cat > "$LIVE/api.env" <<EOF
DATA_MODE=live
API_HOST=127.0.0.1
API_PORT=4000
TRUST_PROXY=127.0.0.1
CORS_ORIGINS=https://rebuy.fun,https://www.rebuy.fun
PUBLIC_SITE_URL=https://rebuy.fun
AUTH_DOMAIN=rebuy.fun
PINATA_JWT=$PINATA
EOF
cat > "$LIVE/web.env" <<EOF
NEXT_PUBLIC_API_URL=/api
NEXT_PUBLIC_WS_URL=wss://rebuy.fun/live
NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta
NEXT_PUBLIC_RPC_URL=https://mainnet.helius-rpc.com/?api-key=$HELIUS_WEB
NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/
API_INTERNAL_URL=http://127.0.0.1:4000
EOF
echo "BUYBACK_WALLET_KEYPAIR_PATH=$KEYS/buyback.json" > "$LIVE/buyback.env"
echo "DISTRIBUTOR_WALLET_KEYPAIR_PATH=$KEYS/distributor.json" > "$LIVE/payout.env"
echo "PLATFORM_FEE_WALLET_KEYPAIR_PATH=$KEYS/platform-fee.json" > "$LIVE/harvest.env"
cp "$LIVE/harvest.env" "$LIVE/reconcile.env"
: > "$LIVE/indexer.env"
cat > "$LIVE/scripts.env" <<EOF
PLATFORM_ADMIN_KEYPAIR_PATH=$KEYS/platform-admin.json
PLATFORM_FEE_WALLET_KEYPAIR_PATH=$KEYS/platform-fee.json
PUBLIC_SITE_URL=https://rebuy.fun
EOF
unset HELIUS HELIUS_WEB PINATA

# permissions: each process reads only its own file and key (DEPLOY.md, key isolation)
chown root:root "$LIVE" && chmod 755 "$LIVE"
chown root:bf-env "$LIVE/common.env" && chmod 640 "$LIVE/common.env"
for n in api:bf-api buyback:bf-buyback payout:bf-payout harvest:bf-fee reconcile:bf-fee indexer:bf-indexer; do chown "root:${n#*:}" "$LIVE/${n%%:*}.env" && chmod 640 "$LIVE/${n%%:*}.env"; done
chown root:backflow "$LIVE/web.env" && chmod 644 "$LIVE/web.env"
chown root:root "$LIVE/scripts.env" && chmod 600 "$LIVE/scripts.env"
chown bf-buyback "$KEYS/buyback.json" && chown bf-payout "$KEYS/distributor.json" && chown bf-fee "$KEYS/platform-fee.json" && chown root "$KEYS/platform-admin.json"
chmod 400 "$KEYS"/*.json && chmod 711 "$KEYS"
echo "env files written to $LIVE"

say "6/7 Database tables (no blockchain involved)"
(set -a; . "$LIVE/common.env"; . "$LIVE/scripts.env"; set +a; cd "$APP" && pnpm --silent db:deploy) | tail -3

say "7/7 Dry run on mainnet (reads only, sends nothing)"
set +e
(set -a; . "$LIVE/common.env"; . "$LIVE/scripts.env"; set +a; cd "$APP" && pnpm --silent platform:create)
set -e

say "Done. Send Claude everything below this line (it holds no secrets)"
printf 'admin          %s\nplatform-fee   %s\nbuyback        %s\ndistributor    %s\ntreasury       %s\n' "$ADMIN" "$FEE" "$BUY" "$DIST" "$TREASURY"
echo "Back up $KEYS/*.json now (SFTP to an offline, encrypted place). Without them, SOL in these wallets can't be recovered."
