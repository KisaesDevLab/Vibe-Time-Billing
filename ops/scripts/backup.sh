#!/usr/bin/env bash
# =============================================================================
# backup.sh — Appliance backup for Vibe Practice Management
#
# Per QUESTIONS.md Q12 (revised): pg_dump + optional encrypted app-key bundle,
# written to a configurable destination (the /backups volume or an external
# drive mount), with day-based retention.
#
# The SCHEDULE + RETENTION + DESTINATION + "include app keys" live in the DB
# (vibetb.backup_config, a single 'default' row) and are managed from
# Admin → Operations → Backup. This script is the EXECUTOR: it reads that row,
# decides whether a run is due, performs the backup, and records the result in
# vibetb.backup_run. packages/core/src/backup is the source of truth for the
# schedule maths the UI displays; this script mirrors only a simple "is it due"
# check in SQL.
#
# Modes:
#   backup.sh --loop      poll every BACKUP_POLL_SECONDS (default 300) and run
#                         when a scheduled run is due or a manual run was
#                         requested (this is the sidecar entrypoint).
#   backup.sh --tick      evaluate the schedule once; run if due/requested.
#   backup.sh --once      run a backup immediately (manual/legacy).
#   backup.sh             alias for --once (back-compat with the old cron).
#
# Output:
#   <dest>/vibe-tb-YYYY-MM-DD-HHMMSS.sql.gz.gpg      (database dump, encrypted
#                                                     when BACKUP_KEYS_PASSPHRASE
#                                                     is set; plain .sql.gz else)
#   <dest>/vibe-tb-keys-YYYY-MM-DD-HHMMSS.tar.gz.gpg (encrypted key bundle)
#
# Restore with ops/scripts/restore.sh (guided) — or by hand per
# ops/docs/restore.md.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Connection. Prefer DATABASE_URL; fall back to libpq PG* env (the sidecar
# historically set those).
# -----------------------------------------------------------------------------
if [[ -z "${DATABASE_URL:-}" && -n "${PGHOST:-}" ]]; then
  DATABASE_URL="postgresql://${PGUSER:-vibe}:${PGPASSWORD:-}@${PGHOST}:${PGPORT:-5432}/${PGDATABASE:-vibe_tb}"
fi
: "${DATABASE_URL:?DATABASE_URL (or PGHOST/PGUSER/...) must be set}"

POLL_SECONDS="${BACKUP_POLL_SECONDS:-300}"

# Defaults used when the config row can't be read (fresh appliance before the
# 0180 migration, or a DB hiccup) — keep nightly DB backups working regardless.
DEF_ENABLED="true"
DEF_FREQUENCY="${BACKUP_FREQUENCY:-daily}"
DEF_TIME="${BACKUP_TIME_UTC:-02:00}"
DEF_RETENTION="${BACKUP_RETENTION_DAYS:-30}"
DEF_DEST="${BACKUP_DIR:-/backups}"
DEF_INCLUDE_KEYS="false"
DEF_KEY_KEEP="14"

LOG_FILE_FALLBACK="${DEF_DEST}/backup.log"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
log() {
  local msg="[$(date -Iseconds)] $*"
  echo "${msg}"
  echo "${msg}" >> "${LOG_FILE:-$LOG_FILE_FALLBACK}" 2>/dev/null || true
}

# Run a scalar query; echo the single value (empty on error).
psql_q() {
  psql "${DATABASE_URL}" -tAc "$1" 2>/dev/null | head -n1 || true
}

# Run a statement, ignore output. Returns non-zero on failure.
psql_x() {
  psql "${DATABASE_URL}" -tAc "$1" >/dev/null 2>&1
}

config_table_exists() {
  [[ "$(psql_q "SELECT to_regclass('vibetb.backup_config') IS NOT NULL")" == "t" ]]
}

# -----------------------------------------------------------------------------
# Config load → CFG_* globals
# -----------------------------------------------------------------------------
load_config() {
  if config_table_exists; then
    local row
    # Pipe-separated single row; NULLs become empty strings.
    row="$(psql_q "SELECT enabled||'|'||frequency||'|'||time_of_day_utc||'|'||retention_days||'|'||destination_path||'|'||include_app_keys||'|'||key_bundle_keep||'|'||COALESCE(manual_requested_at::text,'') FROM vibetb.backup_config WHERE id='default'")"
    if [[ -n "${row}" ]]; then
      IFS='|' read -r CFG_ENABLED CFG_FREQUENCY CFG_TIME CFG_RETENTION CFG_DEST CFG_INCLUDE_KEYS CFG_KEY_KEEP CFG_MANUAL <<<"${row}"
    fi
  fi
  CFG_ENABLED="${CFG_ENABLED:-$DEF_ENABLED}"
  CFG_FREQUENCY="${CFG_FREQUENCY:-$DEF_FREQUENCY}"
  CFG_TIME="${CFG_TIME:-$DEF_TIME}"
  CFG_RETENTION="${CFG_RETENTION:-$DEF_RETENTION}"
  CFG_DEST="${CFG_DEST:-$DEF_DEST}"
  CFG_INCLUDE_KEYS="${CFG_INCLUDE_KEYS:-$DEF_INCLUDE_KEYS}"
  CFG_KEY_KEEP="${CFG_KEY_KEEP:-$DEF_KEY_KEEP}"
  CFG_MANUAL="${CFG_MANUAL:-}"
  LOG_FILE="${CFG_DEST}/backup.log"
}

# Echo: manual | scheduled | no
backup_due() {
  if ! config_table_exists; then
    # No config table → behave like the legacy nightly cron: always "scheduled"
    # when invoked. (The --loop caller throttles via POLL_SECONDS + the legacy
    # cron only fired once a day.)
    echo "scheduled"
    return
  fi
  psql_q "
    WITH c AS (
      SELECT *, CASE frequency
                  WHEN 'daily' THEN 1
                  WHEN 'every_2_days' THEN 2
                  WHEN 'weekly' THEN 7
                  ELSE 1 END AS interval_days
      FROM vibetb.backup_config WHERE id='default'
    )
    SELECT CASE
      WHEN manual_requested_at IS NOT NULL THEN 'manual'
      WHEN enabled
           -- at/after the configured time-of-day today, and …
           AND to_char(now() AT TIME ZONE 'UTC','HH24:MI') >= time_of_day_utc
           -- … at least interval_days calendar days since the last success
           -- (or never run). Matches packages/core computeNextRunAt.
           AND (last_success_at IS NULL
                OR (now() AT TIME ZONE 'UTC')::date - (last_success_at AT TIME ZONE 'UTC')::date
                     >= interval_days)
        THEN 'scheduled'
      ELSE 'no'
    END
    FROM c"
}

# -----------------------------------------------------------------------------
# Run-record bookkeeping (best-effort; never aborts the backup itself)
# -----------------------------------------------------------------------------
RUN_ID=""

run_begin() {
  local kind="$1"
  if config_table_exists; then
    RUN_ID="$(psql_q "INSERT INTO vibetb.backup_run (kind,status,destination_path,retention_days,triggered_by) VALUES ('${kind}','running',$(sql_str "${CFG_DEST}"),${CFG_RETENTION},'executor') RETURNING id")"
    psql_x "UPDATE vibetb.backup_config SET last_run_at=now(), last_status='running' WHERE id='default'" || true
  fi
}

run_succeed() {
  # args: db_file db_bytes keys_file keys_bytes pruned
  if config_table_exists; then
    [[ -n "${RUN_ID}" ]] && psql_x "UPDATE vibetb.backup_run SET status='completed', db_file=$(sql_str "$1"), db_bytes=$2, keys_file=$(sql_str "$3"), keys_bytes=${4:-NULL}, pruned_count=$5, finished_at=now() WHERE id='${RUN_ID}'" || true
    psql_x "UPDATE vibetb.backup_config SET last_status='completed', last_success_at=now(), last_error=NULL, manual_requested_at=NULL WHERE id='default'" || true
  fi
}

run_fail() {
  local err="$1"
  if config_table_exists; then
    [[ -n "${RUN_ID}" ]] && psql_x "UPDATE vibetb.backup_run SET status='failed', error=$(sql_str "${err}"), finished_at=now() WHERE id='${RUN_ID}'" || true
    # Clear the manual flag so a broken request doesn't hot-loop; scheduled
    # runs retry on the next due window.
    psql_x "UPDATE vibetb.backup_config SET last_status='failed', last_error=$(sql_str "${err}"), manual_requested_at=NULL WHERE id='default'" || true
  fi
}

# Quote a value as a SQL string literal (single-quote escaped), or NULL.
sql_str() {
  if [[ -z "${1:-}" ]]; then echo "NULL"; else echo "'${1//\'/\'\'}'"; fi
}

# When the destination sits on a removable drive (/mnt/* or /media/*) and the
# drive is NOT actually mounted, the path is just an empty directory on the
# internal disk — writing there silently defeats the point of an external
# backup. Fail loudly instead so the run shows up as FAILED in the Backup tab.
require_mounted_destination() {
  [[ "${BACKUP_ALLOW_UNMOUNTED:-}" == "1" ]] && return 0
  local root=""
  case "${CFG_DEST}" in
    /mnt/*)   root="/mnt/$(echo "${CFG_DEST}" | cut -d/ -f3)" ;;
    /media/*) root="/media/$(echo "${CFG_DEST}" | cut -d/ -f3)" ;;
    *) return 0 ;;
  esac
  [[ -d "${root}" ]] || abort "backup drive ${root} not found — is the external drive plugged in?"
  local dev parent_dev
  dev="$(stat -c %d "${root}" 2>/dev/null || echo same)"
  parent_dev="$(stat -c %d "$(dirname "${root}")" 2>/dev/null || echo same)"
  if [[ "${dev}" == "${parent_dev}" ]]; then
    abort "backup drive ${root} is not mounted — plug the external drive back in (or set BACKUP_ALLOW_UNMOUNTED=1 to allow writing to the internal disk)"
  fi
}

abort() {
  log "ERROR: $*"
  run_fail "$*"
  if [[ -n "${BACKUP_FAILURE_WEBHOOK:-}" ]]; then
    curl -fsS -X POST "${BACKUP_FAILURE_WEBHOOK}" -H "Content-Type: application/json" \
      -d "{\"event\":\"backup_failed\",\"timestamp\":\"$(date -Iseconds)\",\"error\":\"$*\"}" || true
  fi
  exit 1
}

# -----------------------------------------------------------------------------
# App-key bundle. Encrypted (gpg symmetric, AES-256) under
# BACKUP_KEYS_PASSPHRASE — a passphrase the OPERATOR holds, never stored on the
# appliance (it is itself one of the secrets being protected). If the
# passphrase is absent we skip the bundle (the DB backup still succeeds) and
# record why.
# -----------------------------------------------------------------------------
KEYS_FILE=""
KEYS_BYTES="NULL"

make_key_bundle() {
  local ts="$1"
  KEYS_FILE=""
  KEYS_BYTES="NULL"
  [[ "${CFG_INCLUDE_KEYS}" == "t" || "${CFG_INCLUDE_KEYS}" == "true" ]] || return 0

  if [[ -z "${BACKUP_KEYS_PASSPHRASE:-}" ]]; then
    log "include_app_keys is on but BACKUP_KEYS_PASSPHRASE is not set — skipping key bundle"
    return 0
  fi
  if ! command -v gpg >/dev/null 2>&1; then
    log "gpg not available — skipping key bundle"
    return 0
  fi

  local staging out
  staging="$(mktemp -d)"
  # Collect appliance secrets that are present in the environment.
  {
    local v
    for v in KMS_KEY STAFF_JWT_SECRET PORTAL_JWT_SECRET POSTGRES_PASSWORD \
             PROPOSAL_SIGNATURE_HMAC_SEED VAPID_PRIVATE_KEY VAPID_PUBLIC_KEY \
             OPENSIGN_MASTER_KEY OPENSIGN_WEBHOOK_SECRET B2_KEY_ID B2_APPLICATION_KEY; do
      if [[ -n "${!v:-}" ]]; then
        printf '%s=%s\n' "${v}" "${!v}"
      fi
    done
  } > "${staging}/keys.env"
  chmod 600 "${staging}/keys.env"

  # Sealed-on-disk master key, if this appliance uses that mode. Honor the
  # api's FIRM_KEY_SEAL_PATH (default /data/.firm-key.seal) so the bundle
  # captures the seal wherever it lives.
  local seal_path="${FIRM_KEY_SEAL_PATH:-/data/.firm-key.seal}"
  [[ -f "${seal_path}" ]] && cp -p "${seal_path}" "${staging}/firm-key.seal" 2>/dev/null || true
  # Operator-mounted secret env files (read-only), if provided.
  if [[ -d /secrets ]]; then
    cp -p /secrets/*.env "${staging}/" 2>/dev/null || true
  fi

  out="${CFG_DEST}/vibe-tb-keys-${ts}.tar.gz.gpg"
  if tar -C "${staging}" -czf - . \
      | gpg --batch --yes --symmetric --cipher-algo AES256 \
            --passphrase "${BACKUP_KEYS_PASSPHRASE}" -o "${out}" 2>>"${LOG_FILE}"; then
    chmod 600 "${out}" || true
    KEYS_FILE="${out}"
    KEYS_BYTES="$(stat -c%s "${out}" 2>/dev/null || stat -f%z "${out}" 2>/dev/null || echo 0)"
    log "key bundle written → ${out} (${KEYS_BYTES} bytes, encrypted AES-256)"
  else
    log "warning: key bundle encryption failed (non-fatal) — DB backup continues"
  fi
  rm -rf "${staging}"
}

prune_key_bundles() {
  # Keep the newest CFG_KEY_KEEP encrypted bundles; delete the rest.
  local keep="${CFG_KEY_KEEP:-14}"
  local extra
  extra=$(ls -1t "${CFG_DEST}"/vibe-tb-keys-*.tar.gz.gpg 2>/dev/null | tail -n "+$((keep + 1))" || true)
  if [[ -n "${extra}" ]]; then
    echo "${extra}" | xargs -r rm -f --
    log "pruned $(echo "${extra}" | wc -l) old key bundle(s) (keeping ${keep})"
  fi
}

# -----------------------------------------------------------------------------
# Core backup
# -----------------------------------------------------------------------------
do_backup() {
  local kind="${1:-manual}"
  local ts backup_file size_bytes pruned_count
  ts="$(date +%Y-%m-%d-%H%M%S)"
  backup_file="${CFG_DEST}/vibe-tb-${ts}.sql.gz"

  run_begin "${kind}"
  require_mounted_destination
  mkdir -p "${CFG_DEST}"
  log "Starting ${kind} backup → ${backup_file} (retention ${CFG_RETENTION}d, dest ${CFG_DEST})"

  pg_isready -d "${DATABASE_URL}" >/dev/null 2>&1 || abort "Postgres not reachable at DATABASE_URL"

  pg_dump "${DATABASE_URL}" --no-owner --no-acl --clean --if-exists --quote-all-identifiers \
    2>>"${LOG_FILE}" | gzip --best > "${backup_file}" || abort "pg_dump failed (see ${LOG_FILE})"
  chmod 600 "${backup_file}" || log "warning: could not chmod 600 ${backup_file}"

  size_bytes=$(stat -c%s "${backup_file}" 2>/dev/null || stat -f%z "${backup_file}" 2>/dev/null || echo 0)
  (( size_bytes < 1024 )) && abort "Backup file too small (${size_bytes} bytes) — likely failed"
  gunzip -t "${backup_file}" 2>/dev/null || abort "Backup file failed gzip integrity check"
  log "DB backup verified — ${backup_file} (${size_bytes} bytes)"

  # Encrypt the dump at rest. Backup drives travel — a lost or stolen drive
  # must not leak the practice database. Uses the same operator passphrase as
  # the key bundle; when it isn't set the dump stays plain (and we say so).
  if [[ -n "${BACKUP_KEYS_PASSPHRASE:-}" ]] && command -v gpg >/dev/null 2>&1; then
    if gpg --batch --yes --symmetric --cipher-algo AES256 \
         --passphrase "${BACKUP_KEYS_PASSPHRASE}" -o "${backup_file}.gpg" "${backup_file}" 2>>"${LOG_FILE}"; then
      rm -f "${backup_file}"
      backup_file="${backup_file}.gpg"
      chmod 600 "${backup_file}" || true
      size_bytes=$(stat -c%s "${backup_file}" 2>/dev/null || stat -f%z "${backup_file}" 2>/dev/null || echo 0)
      log "DB backup encrypted at rest → ${backup_file} (${size_bytes} bytes, AES-256)"
    else
      log "warning: DB dump encryption failed — keeping UNENCRYPTED ${backup_file}"
    fi
  else
    log "note: BACKUP_KEYS_PASSPHRASE not set — DB dump is stored UNENCRYPTED"
  fi

  # Optional encrypted app-key bundle.
  make_key_bundle "${ts}"

  # Prune by retention (both encrypted .sql.gz.gpg and legacy plain .sql.gz).
  log "Pruning DB backups older than ${CFG_RETENTION} days…"
  pruned_count=$(find "${CFG_DEST}" \( -name 'vibe-tb-*.sql.gz' -o -name 'vibe-tb-*.sql.gz.gpg' \) -mtime "+${CFG_RETENTION}" -delete -print | wc -l)
  log "Pruned ${pruned_count} old backup(s)"
  prune_key_bundles

  run_succeed "${backup_file}" "${size_bytes}" "${KEYS_FILE}" "${KEYS_BYTES}" "${pruned_count}"

  if [[ -n "${BACKUP_SUCCESS_WEBHOOK:-}" ]]; then
    curl -fsS -X POST "${BACKUP_SUCCESS_WEBHOOK}" -H "Content-Type: application/json" \
      -d "{\"event\":\"backup_succeeded\",\"timestamp\":\"$(date -Iseconds)\",\"file\":\"${backup_file}\",\"size_bytes\":${size_bytes}}" \
      || log "Warning: success webhook failed (non-fatal)"
  fi
  log "Backup job complete (${kind})"
}

# -----------------------------------------------------------------------------
# Entry
# -----------------------------------------------------------------------------
tick() {
  load_config
  local due
  due="$(backup_due)"
  case "${due}" in
    manual)    log "manual backup requested"; do_backup "manual" ;;
    scheduled) log "scheduled backup due";    do_backup "scheduled" ;;
    *)         : ;; # not due — quiet
  esac
}

main() {
  case "${1:---once}" in
    --loop)
      log "backup executor starting (poll ${POLL_SECONDS}s)"
      while true; do
        tick || log "tick failed (continuing)"
        sleep "${POLL_SECONDS}"
      done
      ;;
    --tick)
      tick
      ;;
    --once|"")
      load_config
      do_backup "manual"
      ;;
    *)
      echo "usage: backup.sh [--loop|--tick|--once]" >&2
      exit 2
      ;;
  esac
}

main "$@"
