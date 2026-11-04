#!/usr/bin/env bash
# Nightly PostgreSQL backup for Backflow (SPEC §12). Keeps 14 days.
# Reads DATABASE_URL from /etc/backflow/backflow.env.
set -euo pipefail
ENV_FILE="${BACKFLOW_ENV_FILE:-/etc/backflow/backflow.env}"
DEST="${BACKFLOW_BACKUP_DIR:-/var/backups/backflow}"
KEEP_DAYS="${BACKFLOW_BACKUP_DAYS:-14}"

DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [ -z "$DATABASE_URL" ]; then echo "DATABASE_URL not found in $ENV_FILE" >&2; exit 1; fi

mkdir -p "$DEST"
chmod 700 "$DEST"
FILE="$DEST/backflow-$(date -u +%Y%m%d).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
chmod 600 "$FILE"
find "$DEST" -name 'backflow-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
