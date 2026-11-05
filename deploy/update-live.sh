#!/bin/bash
# Ship a code update to the live site. Pauses, wallets and settings are left exactly as they are.
#   sudo bash /opt/backflow/deploy/update-live.sh
# 1. pulls the code and installs packages (as backflow);
# 2. runs the database migrations;
# 3. builds the site into .next-build and swaps it in, so the live site keeps serving during the build;
# 4. installs the Nginx site from deploy/nginx/rebuy.fun.conf (the old one is put back if nginx -t fails);
# 5. restarts web, api and the five workers under root's PM2, each as its own user (D-046);
# 6. checks health and shows whether buybacks and payouts are paused.
set -euo pipefail
umask 022
APP=${APP:-/opt/backflow}
LIVE=${LIVE:-/etc/backflow-live}
KEYS=${KEYS:-/etc/backflow/keys}
MEDIA=${MEDIA_DIR:-/var/lib/rebuy/media}
SKIP_PULL=${SKIP_PULL:-0}; SKIP_BUILD=${SKIP_BUILD:-0}; SKIP_NGINX=${SKIP_NGINX:-0}   # tests only
NAMES="web api indexer buyback payout harvest reconcile"
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
[ -f "$LIVE/common.env" ] || { echo "The live settings are missing: run the mainnet-1/2/3 scripts first."; exit 1; }

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
op() { (set -a; . "$LIVE/common.env"; . "$LIVE/scripts.env"; set +a; cd "$APP" && pnpm --silent "$@") 2>&1 | grep -v '^bigint: Failed to load bindings' || true; }
as_backflow() { sudo -u backflow -H env "PATH=$PATH" bash -c "$1"; }

say "1/6 Code"
if [ "$SKIP_PULL" != 1 ]; then
  as_backflow "cd '$APP' && git pull -q && pnpm install --frozen-lockfile --silent" || { echo "Updating the code failed (see above). Nothing else was changed."; exit 1; }
fi
git -C "$APP" log -1 --format='code at %h  %s' 2>/dev/null || true

say "2/6 Database"
op db:deploy | tail -2

say "3/6 Build the site (a few minutes; the live site keeps running)"
id bf-web >/dev/null 2>&1 || adduser --system --group --no-create-home bf-web >/dev/null
if [ "$SKIP_BUILD" != 1 ]; then
  LOG=$(mktemp)
  if ! as_backflow "cd '$APP' && rm -rf apps/web/.next-build && NEXT_DIST_DIR=.next-build pnpm --filter @backflow/web build" > "$LOG" 2>&1; then
    echo "The build failed; the site keeps running the previous build. Last lines:"; tail -20 "$LOG"; rm -f "$LOG"; exit 1
  fi
  rm -f "$LOG"
  (cd "$APP/apps/web" && rm -rf .next-prev && { [ ! -d .next ] || mv .next .next-prev; } && mv .next-build .next)
fi
# the web runs as bf-web, which may write only Next's cache, never the code (audit)
mkdir -p "$APP/apps/web/.next/cache" && chown -R bf-web:bf-web "$APP/apps/web/.next/cache"
echo "built"

say "4/6 Nginx"
if [ "$SKIP_NGINX" = 1 ]; then echo "skipped"
else
  CONF=$(grep -ls 'server_name rebuy.fun' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null | head -1 || true)
  TARGET=/etc/nginx/sites-available/rebuy.fun; [ -z "$CONF" ] || TARGET=$(readlink -f "$CONF")
  if [ -f "$TARGET" ] && cmp -s "$APP/deploy/nginx/rebuy.fun.conf" "$TARGET"; then echo "unchanged"
  else
    OLD=$(mktemp /root/nginx-rebuy-before-update.XXXXXX); [ ! -f "$TARGET" ] || cp -a "$TARGET" "$OLD"
    install -m 644 "$APP/deploy/nginx/rebuy.fun.conf" "$TARGET"
    [ -n "$CONF" ] || ln -sf "$TARGET" /etc/nginx/sites-enabled/rebuy.fun
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx && echo "installed and reloaded (previous copy: $OLD)"
    else
      if [ -s "$OLD" ]; then cp -a "$OLD" "$TARGET"; fi
      echo "nginx -t failed with the new site, so the old one was put back. Reason:"; nginx -t 2>&1 | tail -3
    fi
  fi
fi

say "5/6 Restart"
chown root:bf-env "$LIVE/common.env" && chmod 640 "$LIVE/common.env"
for n in api:bf-api buyback:bf-buyback payout:bf-payout harvest:bf-fee reconcile:bf-fee indexer:bf-indexer; do [ ! -f "$LIVE/${n%%:*}.env" ] || { chown "${n#*:}:root" "$LIVE/${n%%:*}.env" && chmod 400 "$LIVE/${n%%:*}.env"; }; done
chown root:backflow "$LIVE/web.env" && chmod 644 "$LIVE/web.env"
for f in buyback:bf-buyback distributor:bf-payout platform-fee:bf-fee; do [ ! -f "$KEYS/${f%%:*}.json" ] || chown "${f#*:}" "$KEYS/${f%%:*}.json"; done
[ ! -d "$MEDIA" ] || { chown bf-api:bf-api "$MEDIA" && chmod 755 "$MEDIA"; }
for n in $NAMES; do pm2 delete "$n" >/dev/null 2>&1 || true; done
(cd "$APP" && BACKFLOW_SPLIT_USERS=1 BACKFLOW_ENV_DIR="$LIVE" pm2 start ecosystem.config.js >/dev/null)
pm2 save --force >/dev/null
echo "restarted"

say "6/6 Health"
sleep 20
for p in 4000 4101 4102 4103 4104 4105; do printf 'port %s  ' "$p"; curl -s -m 5 "127.0.0.1:$p/health" | head -c 110 || printf 'no answer'; echo; done
printf 'site: '; curl -s -m 10 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/ || echo "no answer"
printf 'website RPC: '; curl -s -m 10 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:4000/rpc | head -c 100; echo
ps -o user=,args= -C node | grep -E 'tsx|next' | awk '{print "  " $1 "  " $NF}' | sort -u

say "Done. Send Claude everything below this line (it holds no secrets)"
git -C "$APP" log -1 --format='code %h' 2>/dev/null || true
pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=s.trim().split("\n").pop()||"[]";const want=process.argv[1].split(" ");for(const p of j.startsWith("[")?JSON.parse(j):[])if(want.includes(p.name))console.log(`${p.name.padEnd(10)} ${p.pm2_env.status.padEnd(8)} restarts ${p.pm2_env.restart_time}`)})' "$NAMES"
op admin overview | grep -iE 'pause|buyback|payout' | head -6
