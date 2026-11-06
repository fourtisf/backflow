#!/bin/bash
# Give Rebuy its own Redis when the shared one refuses it (indexer/API log: "NOAUTH Authentication required").
#   sudo bash /opt/backflow/deploy/fix-redis.sh
# Rebuy uses Redis only to pass live events to the website (WebSocket) and to wake workers early. Nothing is
# stored in it, so a separate instance changes no data (D-056). It runs as the systemd service `rebuy-redis`
# on 127.0.0.1 (port 6380, or the next free one) with its own password. The password goes into
# /etc/backflow-live/common.env and is never printed. Other apps' Redis is left exactly as it is.
# Does nothing if Rebuy's current Redis setting already answers (FORCE=1 sets up the own instance anyway).
set -euo pipefail
umask 077
APP=${APP:-/opt/backflow}
LIVE=${LIVE:-/etc/backflow-live}
CONF=/etc/rebuy/redis.conf
DATA=/var/lib/rebuy/redis
UNIT=/etc/systemd/system/rebuy-redis.service
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
[ -f "$LIVE/common.env" ] || { echo "$LIVE/common.env is missing: run the mainnet-1/2/3 scripts first."; exit 1; }
say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

# Does this redis:// URL answer PING? The password goes to redis-cli in REDISCLI_AUTH, never on a command line.
ping_url() {
  local re='^redis://(:([^@]*)@)?([^:/@]+):([0-9]+)'
  [[ $1 =~ $re ]] || return 1
  local pw=${BASH_REMATCH[2]} h=${BASH_REMATCH[3]} p=${BASH_REMATCH[4]}
  if [ -n "$pw" ]; then REDISCLI_AUTH=$pw timeout 5 redis-cli -h "$h" -p "$p" ping 2>/dev/null; else timeout 5 redis-cli -h "$h" -p "$p" ping 2>/dev/null; fi | grep -q '^PONG$'
}

say "1/4 Check"
if ! command -v redis-server >/dev/null || ! command -v redis-cli >/dev/null; then
  apt-get install -y -q redis-server redis-tools >/dev/null
fi
CUR=$(grep -m1 '^REDIS_URL=' "$LIVE/common.env" | cut -d= -f2- || true)
if [ "${FORCE:-0}" != 1 ] && [ -n "$CUR" ] && ping_url "$CUR"; then
  echo "Rebuy's Redis answers. Nothing to change."
  exit 0
fi
echo "Rebuy's Redis setting doesn't answer (refused or down). Setting up Rebuy's own Redis."
who=$(ss -ltnpH 'sport = :6379' 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true)
[ -z "$who" ] || echo "(port 6379 is served by: $who. It is left as it is.)"

say "2/4 Rebuy's own Redis"
PW=$(grep -m1 '^requirepass ' "$CONF" 2>/dev/null | awk '{print $2}' || true)
[ -n "$PW" ] || PW=$(openssl rand -hex 24)
PORT=$(grep -m1 '^port ' "$CONF" 2>/dev/null | awk '{print $2}' || true)
if [ -z "$PORT" ]; then
  for p in 6380 6381 6382 6383 6384 6385 6386 6387 6388 6389; do
    ss -ltnH "sport = :$p" 2>/dev/null | grep -q . || { PORT=$p; break; }
  done
fi
[ -n "$PORT" ] || { echo "No free port between 6380 and 6389."; exit 1; }
mkdir -p /etc/rebuy "$DATA"
cat > "$CONF" <<EOF
# Rebuy's own Redis (deploy/fix-redis.sh, D-056): live events and worker wake-ups only, nothing stored.
bind 127.0.0.1
port $PORT
protected-mode yes
requirepass $PW
daemonize no
supervised no
dir $DATA
save ""
appendonly no
maxmemory 64mb
maxmemory-policy allkeys-lru
loglevel warning
logfile ""
EOF
chown redis:redis "$CONF" "$DATA"
chmod 600 "$CONF"
chmod 700 "$DATA"
chmod 755 /etc/rebuy
cat > "$UNIT" <<EOF
[Unit]
Description=Redis for Rebuy (live events)
After=network.target

[Service]
User=redis
Group=redis
ExecStart=$(command -v redis-server) $CONF
Restart=always
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable rebuy-redis >/dev/null 2>&1
systemctl restart rebuy-redis
NEW="redis://:$PW@127.0.0.1:$PORT"
for _ in $(seq 1 30); do ping_url "$NEW" && break; sleep 0.5; done
if ! ping_url "$NEW"; then
  echo "rebuy-redis didn't start. Nothing else was changed. Last lines:"
  journalctl -u rebuy-redis -n 15 --no-pager || true
  exit 1
fi
echo "rebuy-redis answers on 127.0.0.1:$PORT"

say "3/4 Setting"
# every env file that sets REDIS_URL (a later one would override common.env); owner and mode are kept
for f in "$LIVE"/*.env; do
  [ "$f" = "$LIVE/common.env" ] || grep -q '^REDIS_URL=' "$f" || continue
  T=$(mktemp)
  NEW=$NEW awk '/^REDIS_URL=/ { if (!d) print "REDIS_URL=" ENVIRON["NEW"]; d = 1; next } { print } END { if (!d) print "REDIS_URL=" ENVIRON["NEW"] }' "$f" > "$T"
  cat "$T" > "$f"
  rm -f "$T"
  echo "REDIS_URL set in $f (password not shown)"
done

say "4/4 Restart Rebuy"
SKIP_PULL=1 SKIP_BUILD=1 SKIP_NGINX=1 bash "$APP/deploy/update-live.sh"
sleep 5
n=$(REDISCLI_AUTH=$PW redis-cli -p "$PORT" client list 2>/dev/null | grep -c '^id=' || true)
echo
echo "Rebuy processes connected to its Redis: $((n > 0 ? n - 1 : 0)) (should be 7 or more)"
