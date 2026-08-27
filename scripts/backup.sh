#!/usr/bin/env bash
#
# Dumps the database to a compressed, timestamped file and prunes old ones.
#
# Exports cover the prospect lists, but not the two things that are
# genuinely expensive to rebuild: EmailCache and DomainCache. Those are what
# stop you re-paying for addresses and domains you have already verified,
# and they only get more valuable the longer the tool runs. A single
# `docker compose down -v` removes them.
#
#   ./scripts/backup.sh                  # write a dump
#   ./scripts/backup.sh --verify         # write one and check it restores
#
# Schedule daily with cron:
#   0 3 * * * cd /root/no2ninja-verifier && ./scripts/backup.sh >> /var/log/verifier-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/root/verifier-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
CONTAINER="${POSTGRES_CONTAINER:-no2ninja-verifier-postgres-1}"
DB_USER="${POSTGRES_USER:-verifier}"
DB_NAME="${POSTGRES_DB:-verifier}"

timestamp=$(date +%Y%m%d-%H%M%S)
outfile="${BACKUP_DIR}/verifier-${timestamp}.sql.gz"

mkdir -p "$BACKUP_DIR"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: postgres container '${CONTAINER}' is not running" >&2
  exit 1
fi

echo "Dumping ${DB_NAME} -> ${outfile}"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip -9 > "$outfile"

# A dump that cannot be read is not a backup. Check before reporting success.
if ! gzip -t "$outfile"; then
  echo "ERROR: dump is corrupt, removing" >&2
  rm -f "$outfile"
  exit 1
fi

size=$(du -h "$outfile" | cut -f1)
rows=$(gzip -dc "$outfile" | grep -c "^COPY " || true)
echo "Wrote ${size} covering ${rows} table(s)"

if [ "${1:-}" = "--verify" ]; then
  # Restoring into a throwaway database is the only way to know the dump is
  # actually usable, rather than merely well-formed gzip.
  echo "Verifying by restoring into a scratch database..."
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS verify_restore;" >/dev/null
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE verify_restore;" >/dev/null
  gzip -dc "$outfile" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d verify_restore >/dev/null 2>&1
  count=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d verify_restore -tAc \
    "SELECT count(*) FROM \"EmailCache\";" 2>/dev/null || echo "0")
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE verify_restore;" >/dev/null
  echo "Restore verified: ${count} cached addresses recovered"
fi

deleted=$(find "$BACKUP_DIR" -name 'verifier-*.sql.gz' -mtime "+${KEEP_DAYS}" -print -delete | wc -l)
[ "$deleted" -gt 0 ] && echo "Pruned ${deleted} backup(s) older than ${KEEP_DAYS} days"

echo "Done."
