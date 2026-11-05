#!/usr/bin/env bash
# Nightly PostgreSQL backup for Backflow (SPEC §12). Keeps 14 days.
# Reads DATABASE_URL from /etc/backflow/common.env (root:bf-env 640, so run it as root).
set -euo pipefail
ENV_FILE="${BACKFLOW_ENV_FILE:-/etc/backflow/common.env}"
DEST="${BACKFLOW_BACKUP_DIR:-/var/backups/backflow}"
KEEP_DAYS="${BACKFLOW_BACKUP_DAYS:-14}"

DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//')"
if [ -z "$DATABASE_URL" ]; then echo "DATABASE_URL not found in $ENV_FILE" >&2; exit 1; fi

mkdir -p "$DEST"
chmod 700 "$DEST"
FILE="$DEST/backflow-$(date -u +%Y%m%d).sql.gz"
# run as postgres with the database name only: the password never appears in a process list (audit)
DB_NAME=$(printf '%s' "$DATABASE_URL" | sed -E 's|^.*/([^/?]+)(\?.*)?$|\1|')
sudo -u postgres pg_dump --no-owner --no-privileges "$DB_NAME" | gzip -9 > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
chmod 600 "$FILE"
find "$DEST" -name 'backflow-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# Coin images and metadata stored on this server (D-048): the on-chain links point here, so keep copies.
MEDIA="${BACKFLOW_MEDIA_DIR:-}"
if [ -n "$MEDIA" ] && [ -d "$MEDIA" ]; then
  MFILE="$DEST/media-$(date -u +%Y%m%d).tar.gz"
  tar -C "$MEDIA" -czf "$MFILE.tmp" . && mv "$MFILE.tmp" "$MFILE" && chmod 600 "$MFILE"
  # full copies add up on the same disk: keep fewer of them (audit)
  find "$DEST" -name 'media-*.tar.gz' -mtime +"${BACKFLOW_MEDIA_KEEP_DAYS:-3}" -delete
  echo "media backup written: $MFILE ($(du -h "$MFILE" | cut -f1))"
fi
