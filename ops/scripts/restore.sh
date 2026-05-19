#!/usr/bin/env bash
# =============================================================================
# restore.sh — Restore Vibe Time & Billing database from a pg_dump backup
#
# See ops/docs/restore.md for the full procedure including pre-flight checks
# and post-restore tasks. This script is the mechanical part.
#
# Usage:
#   ./restore.sh                              # Interactive — picks latest backup
#   ./restore.sh /backups/vibe-tb-2026-05-18.sql.gz
#   ./restore.sh --latest
#
# This script will:
#   1. Verify the backup file exists and passes gzip integrity check
#   2. Confirm with the user before proceeding (unless --yes is set)
#   3. Drop and recreate the database
#   4. Restore the backup
#   5. Refresh materialized views
#   6. Run sanity-check queries
#
# It will NOT:
#   - Stop the application containers (do that manually first)
#   - Restart workers or flush Redis (per the procedure in restore.md)
# =============================================================================

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"

ASSUME_YES=false
BACKUP_FILE=""

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)
      BACKUP_FILE="$(ls -t "${BACKUP_DIR}"/vibe-tb-*.sql.gz 2>/dev/null | head -1)"
      shift
      ;;
    --yes|-y)
      ASSUME_YES=true
      shift
      ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      BACKUP_FILE="$1"
      shift
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Pick a backup if none specified
# -----------------------------------------------------------------------------
if [[ -z "${BACKUP_FILE}" ]]; then
  echo "Available backups in ${BACKUP_DIR}:"
  ls -lh "${BACKUP_DIR}"/vibe-tb-*.sql.gz 2>/dev/null || {
    echo "ERROR: No backups found in ${BACKUP_DIR}"
    exit 1
  }
  echo ""
  read -r -p "Enter the full path of the backup to restore: " BACKUP_FILE
fi

# -----------------------------------------------------------------------------
# Pre-flight checks
# -----------------------------------------------------------------------------
if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

echo "Verifying backup integrity..."
if ! gunzip -t "${BACKUP_FILE}" 2>/dev/null; then
  echo "ERROR: Backup file failed gzip integrity check"
  exit 1
fi
echo "Backup is intact."

# -----------------------------------------------------------------------------
# Confirm
# -----------------------------------------------------------------------------
echo ""
echo "==============================================="
echo "  WARNING: This will DROP the current database"
echo "  and replace it with the backup contents."
echo ""
echo "  Backup file: ${BACKUP_FILE}"
echo "  Backup size: $(du -h "${BACKUP_FILE}" | cut -f1)"
echo "  Database:    ${DATABASE_URL%%\?*}"
echo "==============================================="
echo ""

if ! ${ASSUME_YES}; then
  read -r -p "Have you stopped the api and worker containers? (yes/no): " stopped
  if [[ "${stopped}" != "yes" ]]; then
    echo "Stop them first: docker compose stop api worker"
    exit 1
  fi
  read -r -p "Type 'RESTORE' to confirm: " confirm
  if [[ "${confirm}" != "RESTORE" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# Take a snapshot of the current (broken) state for forensics
# -----------------------------------------------------------------------------
forensic_file="${BACKUP_DIR}/pre-restore-snapshot-$(date +%Y-%m-%d-%H%M).sql.gz"
echo ""
echo "Taking forensic snapshot of current state → ${forensic_file}"
if pg_dump "${DATABASE_URL}" --no-owner --no-acl 2>/dev/null | gzip > "${forensic_file}"; then
  echo "Forensic snapshot captured (in case rollback is needed)"
else
  echo "WARNING: Forensic snapshot failed (current DB may already be broken). Continuing."
  rm -f "${forensic_file}"
fi

# -----------------------------------------------------------------------------
# Drop and recreate the database
# -----------------------------------------------------------------------------
db_name="$(echo "${DATABASE_URL}" | sed -E 's|.*/([^?]+).*|\1|')"

echo ""
echo "Dropping and recreating database '${db_name}'..."
psql "${DATABASE_URL%/${db_name}*}/postgres" -c "DROP DATABASE IF EXISTS \"${db_name}\";"
psql "${DATABASE_URL%/${db_name}*}/postgres" -c "CREATE DATABASE \"${db_name}\";"

# -----------------------------------------------------------------------------
# Restore
# -----------------------------------------------------------------------------
echo ""
echo "Restoring from ${BACKUP_FILE}..."
if gunzip -c "${BACKUP_FILE}" | psql "${DATABASE_URL}" --quiet 2>&1 | grep -v 'NOTICE' || true; then
  echo "Restore completed."
else
  echo "ERROR: Restore failed. Forensic snapshot is at ${forensic_file}"
  exit 1
fi

# -----------------------------------------------------------------------------
# Refresh materialized views
# -----------------------------------------------------------------------------
echo ""
echo "Refreshing materialized views..."
psql "${DATABASE_URL}" <<SQL
REFRESH MATERIALIZED VIEW CONCURRENTLY realization_view;
REFRESH MATERIALIZED VIEW CONCURRENTLY utilization_view;
REFRESH MATERIALIZED VIEW CONCURRENTLY profitability_view;
REFRESH MATERIALIZED VIEW CONCURRENTLY ar_aging_snapshot;
SQL

# -----------------------------------------------------------------------------
# Sanity checks
# -----------------------------------------------------------------------------
echo ""
echo "Sanity check — row counts in critical tables:"
psql "${DATABASE_URL}" --tuples-only <<SQL
SELECT 'time_entry: ' || count(*) FROM time_entry;
SELECT 'invoice: ' || count(*) FROM invoice;
SELECT 'adjustment: ' || count(*) FROM adjustment;
SELECT 'adjustment_allocation: ' || count(*) FROM adjustment_allocation;
SELECT 'audit_log: ' || count(*) FROM audit_log;
SELECT 'portal_identity: ' || count(*) FROM portal_identity;
SQL

echo ""
echo "Sanity check — adjustment_allocation sum constraint:"
violations=$(psql "${DATABASE_URL}" --tuples-only -c "
  SELECT count(*) FROM (
    SELECT a.id FROM adjustment a
    JOIN adjustment_allocation aa ON aa.adjustment_id = a.id
    GROUP BY a.id, a.total_amount
    HAVING a.total_amount <> SUM(aa.adjustment_amount)
  ) violations;
")
if [[ "${violations// /}" == "0" ]]; then
  echo "  ✓ All adjustment allocations sum to their parent total"
else
  echo "  ✗ ${violations} adjustments have allocation sums that don't match — investigate before restarting workers"
fi

# -----------------------------------------------------------------------------
# Next steps
# -----------------------------------------------------------------------------
cat <<EOF

================================================================
  Restore complete.

  Next steps (see ops/docs/restore.md for full procedure):

  1. Flush Redis to clear stale BullMQ state:
     docker exec vibe-tb-redis redis-cli FLUSHDB

  2. Restart api and worker containers:
     docker compose up -d api worker

  3. Verify health:
     curl -fsS http://localhost:3001/health

  4. Notify users of the data gap window. Records created after
     $(stat -c %y "${BACKUP_FILE}" 2>/dev/null || stat -f %Sm "${BACKUP_FILE}" 2>/dev/null) are not restored.

  Forensic snapshot of pre-restore state:
    ${forensic_file:-not captured}
================================================================
EOF
