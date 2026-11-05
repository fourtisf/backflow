#!/bin/bash
# Remove another app from this VPS so it runs only Rebuy. Server housekeeping, not part of Rebuy itself.
#   sudo bash /opt/backflow/deploy/remove-app.sh kovra          # shows what it found, then asks YES
# Finds the app by name: its processes (PM2 of any user, systemd, Docker, plain), folders, Nginx sites,
# cron jobs, PostgreSQL databases and its Unix user. Before deleting anything it saves ALL of it (code, .env
# files, keys, database dumps, configs) to /root/<name>-backup-<time>.tar.gz (root only), because those
# files may hold wallet keys. Rebuy (/opt/backflow, /etc/backflow*, users backflow and bf-*) is never touched.
set -uo pipefail
NAME=${1:-}
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0 <name>"; exit 1; }
[[ "$NAME" =~ ^[a-z0-9][a-z0-9_-]{2,}$ ]] || { echo "Usage: sudo bash $0 <app name, e.g. kovra>"; exit 1; }
case "$NAME" in rebuy*|backflow*|bf-*|root|postgres|redis*|nginx|www-data|ubuntu|api|web|app|apps|src|node|pm2|opt|srv|var|etc|home|work*|worker*|indexer|buyback|payout|harvest|reconcile|server|next|deploy|media) echo "Refusing to remove '$NAME' (too generic, or part of Rebuy)."; exit 1;; esac
STAMP=$(date +%Y%m%d-%H%M%S)
BK="/root/$NAME-backup-$STAMP"
PROTECT='^(/opt/backflow|/etc/backflow|/etc/backflow-live|/var/lib/rebuy|/home/backflow)(/|$)'

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
has() { echo "$1" | grep -qi -- "$NAME"; }
safe_dir() { local d; d=$(readlink -f "$1" 2>/dev/null) || return 1; [ -d "$d" ] || return 1; [[ "$d" =~ $PROTECT ]] && return 1
  case "$d" in /|/root|/home|/opt|/srv|/var|/var/www|/etc|/usr|/usr/local) return 1;; esac; has "$d" || return 1; echo "$d"; }

# ------------------------------- find -------------------------------
APP_USER=""; id "$NAME" >/dev/null 2>&1 && APP_USER=$NAME
HOME_DIR=""; [ -n "$APP_USER" ] && HOME_DIR=$(getent passwd "$APP_USER" | cut -d: -f6)
PIDS=$( { [ -n "$APP_USER" ] && pgrep -u "$APP_USER"; for p in $(pgrep -f -i -- "$NAME"); do [ "$p" != "$$" ] && echo "$p"; done; } 2>/dev/null | sort -un)
ANC=" "; a=$$; while [ "${a:-0}" -gt 1 ]; do ANC="$ANC$a "; a=$(ps -o ppid= -p "$a" 2>/dev/null | tr -d ' '); done   # never this shell or its parents
PIDS=$(for p in $PIDS; do case "$ANC" in *" $p "*) continue;; esac
  cw=$(readlink "/proc/$p/cwd" 2>/dev/null || true); [[ "$cw" =~ $PROTECT ]] && continue   # never Rebuy's own processes
  case "$(ps -o user= -p "$p" 2>/dev/null | tr -d ' ')" in backflow|bf-*) continue;; esac
  c=$({ tr '\0' ' ' < /proc/$p/cmdline; } 2>/dev/null); case "$c" in *remove-app.sh*|*pgrep*|"") ;; *) echo "$p";; esac; done)

PM2_USERS=""
for u in $( { echo root; ps -eo user=,args= | awk '/PM2 v/ {print $1}'; } | sort -u); do
  id "$u" >/dev/null 2>&1 || continue
  out=$(sudo -u "$u" -H env "PATH=$PATH" pm2 jlist 2>/dev/null | tail -n1)
  [[ "$out" == \[* ]] || continue
  # never Rebuy's own apps, whatever their names (audit)
  names=$(node -e 'const n=process.argv[1].toLowerCase();for(const p of JSON.parse(process.argv[2])){const cwd=String(p.pm2_env.pm_cwd||"");if(/^\/(opt\/backflow|home\/backflow)(\/|$)/.test(cwd))continue;if((p.name+" "+cwd).toLowerCase().includes(n))console.log(p.name)}' "$NAME" "$out" 2>/dev/null)
  [ -n "$names" ] && PM2_USERS="$PM2_USERS $u:$(echo $names | tr ' ' ',')"
done
UNITS=$(systemctl list-unit-files --type=service --type=timer --no-legend 2>/dev/null | awk '{print $1}' | grep -i -- "$NAME" || true)
[ -n "$APP_USER" ] && UNITS="$UNITS $(systemctl list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -x "pm2-$APP_USER.service" || true)"
UNITS=$(echo $UNITS | tr ' ' '\n' | sed '/^$/d' | sort -u)
DOCKERS=$(command -v docker >/dev/null && docker ps -a --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null | grep -i -- "$NAME" | awk '{print $1}' || true)
# -R follows the sites-enabled symlinks, so both the link and its target are listed and moved together
NGINX=$(grep -Ril -- "$NAME" /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d 2>/dev/null | while read -r f; do grep -qi 'rebuy' "$f" || echo "$f"; done | sort -u)
for t in $NGINX; do for l in /etc/nginx/sites-enabled/*; do [ -L "$l" ] && [ "$(readlink -f "$l")" = "$(readlink -f "$t")" ] && NGINX="$NGINX"$'\n'"$l"; done; done
NGINX=$(echo "$NGINX" | sed '/^$/d' | sort -u)
CRON=$(ls /etc/cron.d 2>/dev/null | grep -i -- "$NAME" | sed 's|^|/etc/cron.d/|' || true)

DIRS=""
for d in "$HOME_DIR" /opt/*"$NAME"* /srv/*"$NAME"* /var/www/*"$NAME"* /home/*/*"$NAME"* /root/*"$NAME"* /etc/*"$NAME"* /var/lib/*"$NAME"* /var/log/*"$NAME"*; do
  [ -e "$d" ] || continue; case "$d" in "$BK"*|/root/*-backup-*) continue;; esac
  s=$(safe_dir "$d") && DIRS="$DIRS"$'\n'"$s"
done
for p in $PIDS; do c=$(readlink /proc/$p/cwd 2>/dev/null) && s=$(safe_dir "$c") && DIRS="$DIRS"$'\n'"$s"; done
DIRS=$(echo "$DIRS" | sed '/^$/d' | sort -u | awk 'BEGIN{p=""} { if (p!="" && index($0, p"/")==1) next; print; p=$0 }')
DBS=$(sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname ILIKE '%$NAME%'" 2>/dev/null || true)
ROLES=$(sudo -u postgres psql -tAc "SELECT rolname FROM pg_roles WHERE rolname ILIKE '%$NAME%'" 2>/dev/null || true)

say "Found for '$NAME'"
echo "Unix user:        ${APP_USER:-none}"
echo "processes:        $(for p in $PIDS; do printf '%s(%s) ' "$p" "$(ps -o user= -p "$p" 2>/dev/null | tr -d ' ')"; done)"
echo "PM2 apps:         ${PM2_USERS:-none}"
echo "systemd:          $(echo $UNITS)"
echo "Docker:           $(echo $DOCKERS)"
echo "Nginx sites:      $(echo $NGINX)"
echo "cron:             $(echo $CRON)"
echo "databases:        $(echo $DBS)   roles: $(echo $ROLES)"
echo "folders:"; [ -n "$DIRS" ] && echo "$DIRS" | sed 's/^/                  /' || echo "                  none"
if [ -z "$APP_USER$PIDS$PM2_USERS$(echo $UNITS)$DOCKERS$NGINX$CRON$DBS$DIRS" ]; then echo; echo "Nothing named '$NAME' was found. Nothing to do."; exit 0; fi
echo
echo "Everything above is saved first to $BK.tar.gz (root only), then stopped and deleted."
read -rp "Remove '$NAME' now? Type YES: " ok
[ "$ok" = YES ] || { echo "Cancelled. Nothing changed."; exit 0; }

# ------------------------------- stop -------------------------------
say "1/4 Stop"
for e in $PM2_USERS; do u=${e%%:*}; for n in $(echo "${e#*:}" | tr ',' ' '); do sudo -u "$u" -H env "PATH=$PATH" pm2 delete "$n" >/dev/null 2>&1 && echo "PM2 ($u) stopped $n"; done; sudo -u "$u" -H env "PATH=$PATH" pm2 save --force >/dev/null 2>&1; done
for u in $UNITS; do systemctl disable --now "$u" >/dev/null 2>&1 && echo "systemd stopped $u"; done
for c in $DOCKERS; do docker rm -f "$c" >/dev/null 2>&1 && echo "Docker removed container $c"; done
if [ -n "$APP_USER" ]; then sudo -u "$APP_USER" -H env "PATH=$PATH" pm2 kill >/dev/null 2>&1 || true; pkill -u "$APP_USER" 2>/dev/null; sleep 2; pkill -9 -u "$APP_USER" 2>/dev/null; fi
for p in $PIDS; do kill "$p" 2>/dev/null; done; sleep 1; for p in $PIDS; do kill -9 "$p" 2>/dev/null; done
echo "stopped"

# ------------------------------ backup ------------------------------
say "2/4 Backup (code, .env files, keys, databases, configs)"
mkdir -p "$BK" && chmod 700 "$BK"
for db in $DBS; do sudo -u postgres pg_dump "$db" > "$BK/db-$db.sql" 2>/dev/null && echo "dumped database $db"; done
[ -n "$APP_USER" ] && crontab -u "$APP_USER" -l > "$BK/crontab-$APP_USER.txt" 2>/dev/null
for f in $NGINX $CRON; do mkdir -p "$BK/config$(dirname "$f")"; cp -a "$f" "$BK/config$f"; done
for u in $UNITS; do f=$(systemctl show -p FragmentPath --value "$u" 2>/dev/null); [ -f "$f" ] && mkdir -p "$BK/config$(dirname "$f")" && cp -a "$f" "$BK/config$f"; done
LIST="$BK/folders.txt"; echo "$DIRS" | sed '/^$/d' > "$LIST"
TAR_DIRS=$(cat "$LIST")
if ! tar --ignore-failed-read --exclude='*/node_modules' --exclude='*/.next' --exclude='*/.cache' -czf "$BK.tar.gz" -C / $(for d in $TAR_DIRS; do echo "${d#/}"; done) -C "$(dirname "$BK")" "$(basename "$BK")" 2>"$BK.tar.err"; then
  echo "The backup failed (see $BK.tar.err). Nothing was deleted; the processes are only stopped."; exit 1
fi
chmod 600 "$BK.tar.gz"; rm -rf "$BK" "$BK.tar.err"
echo "backup: $BK.tar.gz ($(du -h "$BK.tar.gz" | cut -f1)); node_modules and build caches left out"

# ------------------------------ delete ------------------------------
say "3/4 Delete"
# Move the site files OUT of Nginx's folders (renaming them in place would leave them included, and a
# sites-enabled symlink would dangle), test, and put them back if Nginx would not start without them.
if [ -n "$NGINX" ]; then
  HOLD="/root/$NAME-nginx-removed-$STAMP"; mkdir -p "$HOLD" && chmod 700 "$HOLD"
  for f in $NGINX; do mkdir -p "$HOLD$(dirname "$f")"; mv "$f" "$HOLD$f"; done
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx && echo "Nginx: removed $(echo $NGINX | wc -w) site file(s), reloaded"; rm -rf "$HOLD"
  else
    for f in $NGINX; do mv "$HOLD$f" "$f"; done; rm -rf "$HOLD"
    echo "Nginx: it would not start without those files, so they were put back. Reason:"; nginx -t 2>&1 | tail -3
  fi
fi
for u in $UNITS; do f=$(systemctl show -p FragmentPath --value "$u" 2>/dev/null); [[ -f "$f" && "$f" == /etc/systemd/system/* ]] && rm -f "$f"; done; systemctl daemon-reload 2>/dev/null
for f in $CRON; do rm -f "$f"; done
[ -n "$APP_USER" ] && crontab -u "$APP_USER" -r 2>/dev/null
for db in $DBS; do sudo -u postgres psql -qc "DROP DATABASE \"$db\";" 2>/dev/null && echo "dropped database $db"; done
for r in $ROLES; do sudo -u postgres psql -qc "DROP ROLE \"$r\";" 2>/dev/null && echo "dropped role $r"; done
for d in $TAR_DIRS; do s=$(safe_dir "$d") && rm -rf -- "$s" && echo "deleted $s"; done
if [ -n "$APP_USER" ]; then userdel "$APP_USER" 2>/dev/null && echo "removed user $APP_USER"; fi

say "4/4 Check"
left=$(pgrep -f -i -- "$NAME" | grep -v "^$$\$" || true)
[ -z "$left" ] && echo "no '$NAME' process left" || ps -o pid=,user=,args= -p $(echo $left | tr ' ' ',')
printf 'rebuy.fun: '; curl -s -m 10 -o /dev/null -w '%{http_code}\n' -H 'Host: rebuy.fun' http://127.0.0.1/ || echo "no answer"
echo
echo "Done. Backup: $BK.tar.gz. Download it (SFTP) if it may hold keys you need, then you can delete it."
