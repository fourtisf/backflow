#!/bin/bash
# Mainnet phase 3: switch rebuy.fun from the demo to live mainnet, with buybacks and payouts PAUSED
# (docs/MAINNET.md §3-4, DECISIONS.md D-043).
#   sudo bash /opt/backflow/deploy/mainnet-3-live.sh
#   sudo bash /opt/backflow/deploy/mainnet-3-live.sh --back-to-demo     # undo: the demo again
# 1. asks for what is still missing: the browser RPC (Helius Secure RPC URL) and the Pinata JWT;
# 2. sets env file ownership for PM2's per-process users (ecosystem.config.js);
# 3. runs the database migrations, then pauses buybacks and payouts (they stay paused until resumed);
# 4. builds the site with the live settings;
# 5. stops the demo and starts web, api and the five workers under root's PM2, each as its own user;
# 6. checks every process's health.
set -euo pipefail
APP=${APP:-/opt/backflow}
LIVE=${LIVE:-/etc/backflow-live}
KEYS=${KEYS:-/etc/backflow/keys}
SKIP_BUILD=${SKIP_BUILD:-0}   # tests only
NAMES="web api indexer buyback payout harvest reconcile"
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
cur() { { grep -m1 "^$2=" "$LIVE/$1" 2>/dev/null || true; } | cut -d= -f2-; }
# replace or add KEY=VALUE, keeping the file's owner and mode
setkv() { local f="$LIVE/$1" t; t=$(mktemp); { grep -v "^$2=" "$f" || true; } > "$t"; printf '%s=%s\n' "$2" "$3" >> "$t"; cat "$t" > "$f"; rm -f "$t"; }
op() { (set -a; . "$LIVE/common.env"; . "$LIVE/scripts.env"; set +a; cd "$APP" && pnpm --silent "$@") 2>&1 | grep -v '^bigint: Failed to load bindings' || true; }
as_backflow() { sudo -u backflow -H env "PATH=$PATH" bash -c "$1"; }
build_web() { [ "$SKIP_BUILD" = 1 ] || as_backflow "cd '$APP' && pnpm --filter @backflow/web build" > /tmp/rebuy-build.log 2>&1; }
# PM2's JSON, skipping anything printed before it (e.g. "[PM2] Spawning PM2 daemon" on first use)
pm2_apps() { pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=s.trim().split("\n").pop()||"[]";const want=process.argv[1].split(" ");for(const p of j.startsWith("[")?JSON.parse(j):[])if(want.includes(p.name))console.log(process.argv[2]==="cwd"?`${p.name} ${p.pm2_env.pm_cwd}`:`${p.name.padEnd(10)} ${p.pm2_env.status.padEnd(8)} restarts ${p.pm2_env.restart_time}`)})' "$NAMES" "$1"; }

if [ "${1:-}" = "--back-to-demo" ]; then
  say "Back to the demo"
  for n in $NAMES; do pm2 delete "$n" >/dev/null 2>&1 || true; done; pm2 save --force >/dev/null 2>&1 || true
  if [ -f "$APP/.env.demo" ]; then rm -f "$APP/.env"; mv "$APP/.env.demo" "$APP/.env"; fi
  echo "building the demo site (a few minutes)..."; build_web || { echo "build failed, see /tmp/rebuy-build.log"; exit 1; }
  as_backflow "cd '$APP' && pm2 start ecosystem.config.js --only web,api >/dev/null && pm2 save >/dev/null"
  echo "The demo is back. Buybacks and payouts stay paused in the live database."
  exit 0
fi

for k in PLATFORM_CONFIG_PUBKEY BACKFLOW_ALT; do [ -n "$(cur common.env $k)" ] || { echo "$k is missing: run deploy/mainnet-2-create.sh first."; exit 1; }; done

say "1/6 Settings still missing"
if [ -z "$(cur web.env NEXT_PUBLIC_RPC_URL)" ]; then
  echo "Browser RPC: in the Helius dashboard open RPCs and copy the 'Secure RPC URL' (made for websites; it hides your key)."
  read -rp "Secure RPC URL: " URL
  [[ "$URL" == https://* ]] || { echo "That is not an https URL. Run this again."; exit 1; }
  SRV=$(cur common.env RPC_URL); SRV=${SRV##*api-key=}
  [[ -z "$SRV" || "$URL" != *"$SRV"* ]] || { echo "That URL holds your server key; anyone could copy it from the site. Use the Secure RPC URL."; exit 1; }
  setkv web.env NEXT_PUBLIC_RPC_URL "${URL%/}"
fi
URL=$(cur web.env NEXT_PUBLIC_RPC_URL)
if curl -s -m 10 -X POST -H 'content-type: application/json' -H 'origin: https://rebuy.fun' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$URL" | grep -q '"ok"'; then echo "browser RPC answers"
else echo "WARNING: the browser RPC did not answer getHealth. Check the URL; the site's wallet actions need it."; fi
if [ -z "$(cur api.env PINATA_JWT)" ]; then
  echo "Pinata (pinata.cloud > API Keys > New Key, admin): the JWT stores coin images when someone launches."
  read -rsp "Pinata JWT (hidden): " JWT; echo
  [ -n "$JWT" ] || { echo "Empty. Run this again."; exit 1; }
  setkv api.env PINATA_JWT "$JWT"; unset JWT
fi
if curl -s -m 10 -H "Authorization: Bearer $(cur api.env PINATA_JWT)" https://api.pinata.cloud/data/testAuthentication | grep -qi congratulations; then echo "Pinata key works"
else echo "WARNING: Pinata did not accept the JWT. Launches will fail until it does; fix it and run this again."; fi

say "2/6 File permissions for each process"
chown root:bf-env "$LIVE/common.env" && chmod 640 "$LIVE/common.env"
for n in api:bf-api buyback:bf-buyback payout:bf-payout harvest:bf-fee reconcile:bf-fee indexer:bf-indexer; do chown "${n#*:}:root" "$LIVE/${n%%:*}.env" && chmod 400 "$LIVE/${n%%:*}.env"; done
chown root:backflow "$LIVE/web.env" && chmod 644 "$LIVE/web.env"
chmod 755 "$LIVE"
for f in buyback:bf-buyback distributor:bf-payout platform-fee:bf-fee; do [ ! -f "$KEYS/${f%%:*}.json" ] || chown "${f#*:}" "$KEYS/${f%%:*}.json"; done
chmod 711 "$KEYS"
sudo -u bf-indexer test -r "$APP/apps/workers/src/indexer.ts" || chmod -R o+rX "$APP"
echo "ok"

say "3/6 Database, and pause buybacks and payouts"
op db:deploy | tail -2
op admin pause buybacks
op admin pause payouts

say "4/6 Build the live site (a few minutes)"
if [ -f "$APP/.env" ] && [ ! -L "$APP/.env" ]; then mv "$APP/.env" "$APP/.env.demo"; fi
ln -sfn "$LIVE/web.env" "$APP/.env"
build_web || { echo "The build failed (see /tmp/rebuy-build.log). The demo keeps running; run: bash $0 --back-to-demo"; exit 1; }
echo "built"

say "5/6 Start the live processes"
while read -r name cwd; do
  [ -z "$name" ] && continue
  case "$cwd" in "$APP"*) ;; *) echo "root's PM2 already runs another app called '$name' (in $cwd). Rename or remove it first."; exit 1;; esac
done <<< "$(pm2 ping >/dev/null 2>&1 || true; pm2_apps cwd)"
as_backflow "pm2 delete web api >/dev/null 2>&1; pm2 save --force >/dev/null 2>&1" || true
for n in $NAMES; do pm2 delete "$n" >/dev/null 2>&1 || true; done
(cd "$APP" && BACKFLOW_SPLIT_USERS=1 BACKFLOW_ENV_DIR="$LIVE" pm2 start ecosystem.config.js >/dev/null)
pm2 save --force >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
echo "started; PM2 will bring them back after a reboot"

say "6/6 Health"
sleep 20
pm2 ls
echo
for p in 4000 4101 4102 4103 4104 4105; do printf 'port %s  ' "$p"; curl -s -m 5 "127.0.0.1:$p/health" | head -c 160 || printf 'no answer'; echo; done
echo
printf 'site: '; curl -s -m 10 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/ || echo "no answer"
ps -o user=,args= -C node | grep -E 'tsx|next' | awk '{print "  " $1 "  " $NF}' | sort -u

say "Done. Send Claude everything below this line (it holds no secrets)"
pm2_apps status
echo "Buybacks and payouts are PAUSED. Next: one small test launch (Claude gives the steps), then resume."
