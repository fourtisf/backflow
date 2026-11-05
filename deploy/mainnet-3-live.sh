#!/bin/bash
# Mainnet phase 3: switch rebuy.fun from the demo to live mainnet, with buybacks and payouts PAUSED
# (docs/MAINNET.md §3-4, DECISIONS.md D-043).
#   sudo bash /opt/backflow/deploy/mainnet-3-live.sh
#   sudo bash /opt/backflow/deploy/mainnet-3-live.sh --back-to-demo     # undo: the demo again
# 1. points the site's RPC at this server (/api/rpc, the Helius key stays private) and keeps coin images on this
#    server (or on Pinata/IPFS with PINATA_JWT=...);
# 2. sets env file ownership for PM2's per-process users (ecosystem.config.js);
# 3. runs the database migrations, then pauses buybacks and payouts (they stay paused until resumed);
# 4. builds the site with the live settings;
# 5. stops the demo and starts web, api and the five workers under root's PM2, each as its own user;
# 6. checks every process's health.
set -euo pipefail
umask 022
APP=${APP:-/opt/backflow}
LIVE=${LIVE:-/etc/backflow-live}
KEYS=${KEYS:-/etc/backflow/keys}
SKIP_BUILD=${SKIP_BUILD:-0}   # tests only
NAMES="web api indexer buyback payout harvest reconcile"
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
cur() { { grep -m1 "^$2=" "$LIVE/$1" 2>/dev/null || true; } | cut -d= -f2-; }
# replace or add KEY=VALUE, keeping the file's owner and mode
# the temp copy stays next to the file (root-only folder) and is private (audit)
setkv() { local f="$LIVE/$1" t; t=$(umask 077; mktemp "$LIVE/.setkv.XXXXXX"); { grep -v "^$2=" "$f" || true; } > "$t"; printf '%s=%s\n' "$2" "$3" >> "$t"; cat "$t" > "$f"; rm -f "$t"; }
op() { (set -a; . "$LIVE/common.env"; . "$LIVE/scripts.env"; set +a; cd "$APP" && pnpm --silent "$@") 2>&1 | grep -v '^bigint: Failed to load bindings' || true; }
as_backflow() { sudo -u backflow -H env "PATH=$PATH" bash -c "$1"; }
# builds into .next-build and swaps it in, so the running site never serves a half-written build (audit)
build_web() {
  [ "$SKIP_BUILD" = 1 ] && return 0
  local log; log=$(mktemp)
  if ! as_backflow "cd '$APP' && rm -rf apps/web/.next-build && NEXT_DIST_DIR=.next-build pnpm --filter @backflow/web build" > "$log" 2>&1; then tail -20 "$log"; rm -f "$log"; return 1; fi
  rm -f "$log"
  (cd "$APP/apps/web" && rm -rf .next-prev && { [ ! -d .next ] || mv .next .next-prev; } && mv .next-build .next)
  id bf-web >/dev/null 2>&1 || adduser --system --group --no-create-home bf-web >/dev/null
  mkdir -p "$APP/apps/web/.next/cache" && chown -R bf-web:bf-web "$APP/apps/web/.next/cache"
}
# PM2's JSON, skipping anything printed before it (e.g. "[PM2] Spawning PM2 daemon" on first use)
pm2_apps() { pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=s.trim().split("\n").pop()||"[]";const want=process.argv[1].split(" ");for(const p of j.startsWith("[")?JSON.parse(j):[])if(want.includes(p.name))console.log(process.argv[2]==="cwd"?`${p.name} ${p.pm2_env.pm_cwd}`:`${p.name.padEnd(10)} ${p.pm2_env.status.padEnd(8)} restarts ${p.pm2_env.restart_time}`)})' "$NAMES" "$1"; }

if [ "${1:-}" = "--back-to-demo" ]; then
  say "Back to the demo"
  for n in $NAMES; do pm2 delete "$n" >/dev/null 2>&1 || true; done; pm2 save --force >/dev/null 2>&1 || true
  if [ -f "$APP/.env.demo" ]; then rm -f "$APP/.env"; mv "$APP/.env.demo" "$APP/.env"; fi
  echo "building the demo site (a few minutes)..."; build_web || { echo "the build failed (see above)"; exit 1; }
  as_backflow "cd '$APP' && pm2 start ecosystem.config.js --only web,api >/dev/null && pm2 save >/dev/null"
  echo "The demo is back. Buybacks and payouts stay paused in the live database."
  exit 0
fi

for k in PLATFORM_CONFIG_PUBKEY BACKFLOW_ALT; do [ -n "$(cur common.env $k)" ] || { echo "$k is missing: run deploy/mainnet-2-create.sh first."; exit 1; }; done

say "1/6 Settings still missing"
# The site reaches Solana through our own API (/api/rpc, D-047), which adds the server's Helius key on the
# server side: no second key or URL to copy. BROWSER_RPC_URL=<Helius Secure RPC URL> uses that instead.
if [ -n "${BROWSER_RPC_URL:-}" ]; then setkv web.env NEXT_PUBLIC_RPC_URL "${BROWSER_RPC_URL%/}"
elif [ -z "$(cur web.env NEXT_PUBLIC_RPC_URL)" ]; then setkv web.env NEXT_PUBLIC_RPC_URL "https://rebuy.fun/api/rpc"; fi
URL=$(cur web.env NEXT_PUBLIC_RPC_URL)
SRV=$(cur common.env RPC_URL); SRV=${SRV##*api-key=}
[[ -z "$SRV" || "$URL" != *"$SRV"* ]] || { echo "The site's RPC URL holds your server key; anyone could copy it. Run again with BROWSER_RPC_URL=https://rebuy.fun/api/rpc"; exit 1; }
if [[ "$URL" == */api/rpc ]]; then echo "website RPC: $URL (through this server; your Helius key stays private)"
elif curl -s -m 10 -X POST -H 'content-type: application/json' -H 'origin: https://rebuy.fun' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$URL" | grep -q '"ok"'; then echo "website RPC answers: $URL"
else echo "WARNING: the website RPC did not answer getHealth ($URL)."; fi
# Coin images: on this server by default (owner's choice, D-048), or Pinata/IPFS when PINATA_JWT is given.
MEDIA=${MEDIA_DIR:-/var/lib/rebuy/media}
[ -z "${PINATA_JWT:-}" ] || setkv api.env PINATA_JWT "$PINATA_JWT"
if [ -n "$(cur api.env PINATA_JWT)" ]; then
  # the JWT goes to curl on stdin (-K -), never on its command line (audit)
  if printf 'header = "Authorization: Bearer %s"\n' "$(cur api.env PINATA_JWT)" | curl -s -m 10 -K - https://api.pinata.cloud/data/testAuthentication | grep -qi congratulations; then echo "coin images: Pinata (IPFS)"
  else echo "WARNING: Pinata did not accept the JWT. Launches will fail until it does; fix it and run this again."; fi
else
  mkdir -p "$MEDIA" && chown bf-api:bf-api "$MEDIA" && chmod 755 "$MEDIA"
  setkv api.env MEDIA_DIR "$MEDIA"
  echo "coin images: on this server ($MEDIA, served at https://rebuy.fun/api/media/). Backed up nightly from now on."
fi

say "2/6 File permissions for each process"
chown root:bf-env "$LIVE/common.env" && chmod 640 "$LIVE/common.env"
for n in api:bf-api buyback:bf-buyback payout:bf-payout harvest:bf-fee reconcile:bf-fee indexer:bf-indexer; do chown "${n#*:}:root" "$LIVE/${n%%:*}.env" && chmod 400 "$LIVE/${n%%:*}.env"; done
chown root:backflow "$LIVE/web.env" && chmod 644 "$LIVE/web.env"
chmod 755 "$LIVE"
for f in buyback:bf-buyback distributor:bf-payout platform-fee:bf-fee; do [ ! -f "$KEYS/${f%%:*}.json" ] || chown "${f#*:}" "$KEYS/${f%%:*}.json"; done
chmod 711 "$KEYS"
sudo -u bf-indexer test -r "$APP/apps/workers/src/indexer.ts" || { echo "The workers' users can't read $APP: run  chmod o+rX $APP  and check the folder modes."; exit 1; }
echo "ok"

say "3/6 Database, and pause buybacks and payouts"
op db:deploy | tail -2
# Pause only on the first switch to live; a re-run must not undo a resume (audit).
if [ -n "$(pm2_apps cwd)" ]; then echo "already live: pauses left as they are"
else
  op admin pause buybacks
  op admin pause payouts
fi

say "4/6 Build the live site (a few minutes)"
if [ -f "$APP/.env" ] && [ ! -L "$APP/.env" ]; then mv "$APP/.env" "$APP/.env.demo"; fi
ln -sfn "$LIVE/web.env" "$APP/.env"
build_web || { echo "The build failed (see above). The previous site keeps running."; exit 1; }
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

# nightly backup of the database and the coin images (kept 14 days in /var/backups/backflow)
install -m 755 "$APP/deploy/backup.sh" /usr/local/bin/rebuy-backup
echo "17 3 * * * root BACKFLOW_ENV_FILE=$LIVE/common.env BACKFLOW_MEDIA_DIR=$MEDIA /usr/local/bin/rebuy-backup >> /var/log/rebuy-backup.log 2>&1" > /etc/cron.d/rebuy-backup

say "6/6 Health"
sleep 20
pm2 ls
echo
for p in 4000 4101 4102 4103 4104 4105; do printf 'port %s  ' "$p"; curl -s -m 5 "127.0.0.1:$p/health" | head -c 160 || printf 'no answer'; echo; done
echo
printf 'site: '; curl -s -m 10 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/ || echo "no answer"
printf 'website RPC: '; curl -s -m 10 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:4000/rpc | head -c 120; echo
ps -o user=,args= -C node | grep -E 'tsx|next' | awk '{print "  " $1 "  " $NF}' | sort -u

say "Done. Send Claude everything below this line (it holds no secrets)"
pm2_apps status
echo "Buybacks and payouts are PAUSED. Next: one small test launch (Claude gives the steps), then resume."
