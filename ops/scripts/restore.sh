#!/usr/bin/env bash
# =============================================================================
# restore.sh — guided restore for the Vibe T&B appliance.
#
# Written so a non-technical operator can follow along with
# ops/docs/DISASTER-RECOVERY.md. Every prompt is plain English; the one
# destructive step requires typing RESTORE. Runs on the HOST (talks to the
# containers with `docker exec`), so no DATABASE_URL or psql install needed.
#
# Modes:
#   restore.sh                       guided, interactive restore (recommended)
#   restore.sh --check               NON-destructive: load the newest backup
#                                    into a throwaway database, verify it, drop
#                                    it. Safe to run any time; the nightly
#                                    automated backup test uses this.
#   restore.sh --keys <bundle.gpg>   decrypt an app-key bundle into a folder
#                                    (recover KMS_KEY, JWT secrets, firm-key
#                                    seal when rebuilding on a fresh machine)
#
# Options:
#   --dir <path>    folder holding the backups (default: asks the appliance,
#                   falling back to /mnt/external/vibe-tb-backups)
#   --file <path>   restore this exact backup file instead of the newest one
#   --yes           skip the interactive confirmation (scripted use)
#   --quiet         only print the final PASS/FAIL line (--check mode)
#
# Environment overrides: PG_CONTAINER (vibe-tb-postgres), DB_NAME (vibe_tb),
# DB_USER (vibe), API_CONTAINER (vibe-tb-api), WORKER_CONTAINER
# (vibe-tb-worker), REDIS_CONTAINER (vibe-tb-redis), BACKUP_KEYS_PASSPHRASE.
# =============================================================================

set -uo pipefail

PG_CONTAINER="${PG_CONTAINER:-vibe-tb-postgres}"
DB_NAME="${DB_NAME:-vibe_tb}"
DB_USER="${DB_USER:-vibe}"
API_CONTAINER="${API_CONTAINER:-vibe-tb-api}"
WORKER_CONTAINER="${WORKER_CONTAINER:-vibe-tb-worker}"
REDIS_CONTAINER="${REDIS_CONTAINER:-vibe-tb-redis}"
CHECK_DB="vibe_tb_restorecheck"

MODE="restore"
BACKUP_DIR=""
BACKUP_FILE=""
ASSUME_YES=0
QUIET=0
KEYS_BUNDLE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --keys)  MODE="keys"; KEYS_BUNDLE="${2:-}"; shift ;;
    --dir)   BACKUP_DIR="${2:-}"; shift ;;
    --file)  BACKUP_FILE="${2:-}"; shift ;;
    --yes)   ASSUME_YES=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { [[ "${QUIET}" == "1" ]] || echo "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }

pg() { docker exec -i "${PG_CONTAINER}" psql -U "${DB_USER}" "$@"; }

# -----------------------------------------------------------------------------
# Shared helpers
# -----------------------------------------------------------------------------

require_postgres() {
  docker inspect "${PG_CONTAINER}" >/dev/null 2>&1 \
    || die "database container '${PG_CONTAINER}' is not running. Start the appliance first (DISASTER-RECOVERY.md, scenario B)."
  pg -d postgres -tAc "SELECT 1" >/dev/null 2>&1 \
    || die "cannot talk to the database inside '${PG_CONTAINER}'."
}

# Passphrase for encrypted files: env var → appliance secrets file → prompt.
PASSPHRASE=""
find_passphrase() {
  [[ -n "${PASSPHRASE}" ]] && return 0
  if [[ -n "${BACKUP_KEYS_PASSPHRASE:-}" ]]; then
    PASSPHRASE="${BACKUP_KEYS_PASSPHRASE}"
    return 0
  fi
  local f
  for f in "${HOME}/appliance-secrets/vibe-build.env" /tmp/vibe-build.env; do
    if [[ -r "${f}" ]]; then
      PASSPHRASE="$(grep -m1 '^BACKUP_KEYS_PASSPHRASE=' "${f}" | cut -d= -f2-)"
      [[ -n "${PASSPHRASE}" ]] && return 0
    fi
  done
  if [[ -t 0 ]]; then
    read -r -s -p "Enter the backup passphrase (from your Recovery Kit sheet): " PASSPHRASE
    echo
    [[ -n "${PASSPHRASE}" ]] && return 0
  fi
  return 1
}

# Resolve the backup folder: --dir → ask the appliance DB → default.
resolve_backup_dir() {
  [[ -n "${BACKUP_DIR}" ]] && return 0
  BACKUP_DIR="$(pg -d "${DB_NAME}" -tAc \
    "SELECT destination_path FROM vibetb.backup_config WHERE id='default'" 2>/dev/null | head -n1)"
  [[ -z "${BACKUP_DIR}" ]] && BACKUP_DIR="/mnt/external/vibe-tb-backups"
  [[ -d "${BACKUP_DIR}" ]] \
    || die "backup folder '${BACKUP_DIR}' is not visible on this machine. Plug in the backup drive, or pass --dir <folder>."
}

# Pick the newest DB backup (encrypted or plain) unless --file was given.
resolve_backup_file() {
  if [[ -n "${BACKUP_FILE}" ]]; then
    [[ -f "${BACKUP_FILE}" ]] || die "backup file not found: ${BACKUP_FILE}"
    return 0
  fi
  resolve_backup_dir
  BACKUP_FILE="$(ls -1t "${BACKUP_DIR}"/vibe-tb-*.sql.gz.gpg "${BACKUP_DIR}"/vibe-tb-*.sql.gz 2>/dev/null | head -n1)"
  [[ -n "${BACKUP_FILE}" ]] || die "no backup files (vibe-tb-*.sql.gz[.gpg]) found in ${BACKUP_DIR}"
}

# Stream the (possibly encrypted) dump as plain SQL on stdout.
stream_dump() {
  local f="$1"
  case "${f}" in
    *.sql.gz.gpg)
      find_passphrase || die "this backup is encrypted and no passphrase was found. It is on your printed Recovery Kit sheet."
      gpg --batch --quiet --decrypt --passphrase "${PASSPHRASE}" "${f}" 2>/dev/null | gunzip -c
      ;;
    *.sql.gz) gunzip -c "${f}" ;;
    *) die "unrecognized backup file type: ${f}" ;;
  esac
}

# Restore a dump stream into a database; echoes the number of SQL errors.
restore_into() {
  local db="$1" file="$2" errlog errs
  errlog="$(mktemp)"
  stream_dump "${file}" | pg -d "${db}" -q >/dev/null 2>"${errlog}"
  errs="$(grep -c 'ERROR:' "${errlog}" || true)"
  if [[ "${errs}" != "0" && "${QUIET}" != "1" ]]; then
    echo "--- first errors during restore:" >&2
    grep -m5 'ERROR:' "${errlog}" >&2 || true
  fi
  rm -f "${errlog}"
  echo "${errs}"
}

sanity_counts() {
  # One line: clients|time entries|invoices|key envelopes. Empty on failure.
  pg -d "$1" -tAc "SELECT (SELECT count(*) FROM vibetb.client)||'|'||(SELECT count(*) FROM vibetb.time_entry)||'|'||(SELECT count(*) FROM vibetb.invoice)||'|'||(SELECT count(*) FROM vibetb.firm_key_envelope)" 2>/dev/null | head -n1
}

# -----------------------------------------------------------------------------
# --check: prove the newest backup restores, without touching live data
# -----------------------------------------------------------------------------

do_check() {
  require_postgres
  resolve_backup_file
  say "Backup being tested : ${BACKUP_FILE}"

  pg -d postgres -qc "DROP DATABASE IF EXISTS ${CHECK_DB};" >/dev/null 2>&1
  pg -d postgres -qc "CREATE DATABASE ${CHECK_DB} OWNER ${DB_USER};" >/dev/null 2>&1 \
    || die "could not create scratch database"

  local errs counts clients envelopes
  errs="$(restore_into "${CHECK_DB}" "${BACKUP_FILE}")"
  counts="$(sanity_counts "${CHECK_DB}")"
  pg -d postgres -qc "DROP DATABASE IF EXISTS ${CHECK_DB};" >/dev/null 2>&1

  clients="$(echo "${counts}" | cut -d'|' -f1)"
  envelopes="$(echo "${counts}" | cut -d'|' -f4)"

  if [[ "${errs}" == "0" && -n "${counts}" && "${clients:-0}" -gt 0 && "${envelopes:-0}" -ge 1 ]]; then
    echo "RESTORE TEST PASSED — $(basename "${BACKUP_FILE}") restored cleanly (${clients} clients, key envelope present)"
    exit 0
  else
    echo "RESTORE TEST FAILED — file=$(basename "${BACKUP_FILE}") sql_errors=${errs} counts='${counts}'"
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# --keys: recover an app-key bundle on a fresh machine
# -----------------------------------------------------------------------------

do_keys() {
  [[ -n "${KEYS_BUNDLE}" && -f "${KEYS_BUNDLE}" ]] || die "usage: restore.sh --keys <vibe-tb-keys-....tar.gz.gpg>"
  find_passphrase || die "no passphrase available — it is on your printed Recovery Kit sheet."
  local out
  out="recovered-keys-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "${out}" && chmod 700 "${out}"
  gpg --batch --quiet --decrypt --passphrase "${PASSPHRASE}" "${KEYS_BUNDLE}" 2>/dev/null \
    | tar -xzf - -C "${out}" || die "could not decrypt ${KEYS_BUNDLE} — wrong passphrase?"
  echo "Keys recovered into ./${out}/ :"
  ls -l "${out}"
  cat <<EOF

What these files are:
  keys.env / *.env   → the appliance's secret settings. Use as the --env-file
                       when starting the appliance so it can read its own
                       database.
  firm-key.seal      → the firm's master key file. Copy it into the 'firm-key'
                       Docker volume as /data/firm-key/.firm-key.seal
                       (mode 0400) BEFORE starting the app. Without it,
                       encrypted data — including the cloud file-storage
                       credentials — cannot be read.

Full step-by-step: ops/docs/DISASTER-RECOVERY.md, scenario B/C.
SECURITY: delete ./${out}/ once the appliance is running.
EOF
}

# -----------------------------------------------------------------------------
# Full guided restore
# -----------------------------------------------------------------------------

wait_healthy() {
  local tries=40
  while (( tries-- > 0 )); do
    if curl -fsS http://localhost:3001/health >/dev/null 2>&1 \
       || docker exec "${API_CONTAINER}" curl -fsS http://localhost:3001/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

do_restore() {
  require_postgres
  resolve_backup_file

  local fname when size
  fname="$(basename "${BACKUP_FILE}")"
  when="$(echo "${fname}" | sed -E 's/vibe-tb-([0-9-]+)-([0-9]{2})([0-9]{2})[0-9]{2}.*/\1 \2:\3 UTC/')"
  size="$(du -h "${BACKUP_FILE}" | cut -f1)"

  echo "==================================================================="
  echo " Vibe T&B — DATABASE RESTORE"
  echo "==================================================================="
  echo
  echo " Backup file : ${fname} (${size})"
  echo " Taken       : ${when}"
  echo
  echo " This will REPLACE all current data in the application with the"
  echo " contents of that backup. Anything entered after the backup was"
  echo " taken will be gone. (A safety copy of the current data is saved"
  echo " first, so this can be undone.)"
  echo
  if [[ "${ASSUME_YES}" != "1" ]]; then
    read -r -p " Type RESTORE (all capitals) to continue, anything else to cancel: " answer
    [[ "${answer}" == "RESTORE" ]] || { echo " Cancelled — nothing was changed."; exit 0; }
  fi

  # If the backup is encrypted, prove we can decrypt BEFORE stopping the app.
  case "${BACKUP_FILE}" in *.gpg)
    find_passphrase || die "this backup is encrypted and no passphrase was found. It is on your printed Recovery Kit sheet."
    gpg --batch --quiet --decrypt --passphrase "${PASSPHRASE}" "${BACKUP_FILE}" 2>/dev/null | head -c1 >/dev/null \
      || die "wrong passphrase for ${fname} — check the Recovery Kit sheet."
  esac

  echo
  echo " [1/7] Saving a safety copy of the current data…"
  local snap
  snap="$(dirname "${BACKUP_FILE}")/pre-restore-snapshot-$(date +%Y-%m-%d-%H%M%S).sql.gz"
  if docker exec "${PG_CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" --no-owner --no-acl --clean --if-exists --quote-all-identifiers 2>/dev/null | gzip > "${snap}" && [[ -s "${snap}" ]]; then
    echo "       saved: ${snap}"
  else
    rm -f "${snap}"
    snap="(not captured — current database was not readable)"
    echo "       could not snapshot the current database (it may already be broken) — continuing."
  fi

  echo " [2/7] Stopping the application (database stays up)…"
  docker stop "${API_CONTAINER}" "${WORKER_CONTAINER}" >/dev/null 2>&1

  echo " [3/7] Clearing the old database…"
  pg -d postgres -qc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid<>pg_backend_pid();" >/dev/null 2>&1
  if ! pg -d postgres -qc "DROP DATABASE IF EXISTS ${DB_NAME};"; then
    docker start "${API_CONTAINER}" "${WORKER_CONTAINER}" >/dev/null 2>&1
    die "could not clear the old database — the application has been restarted; nothing was changed."
  fi
  pg -d postgres -qc "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" \
    || die "could not create a fresh database. Get IT help; the safety copy is at: ${snap}"

  echo " [4/7] Loading the backup (this can take a few minutes)…"
  local errs
  errs="$(restore_into "${DB_NAME}" "${BACKUP_FILE}")"
  if [[ "${errs}" != "0" ]]; then
    echo "       WARNING: ${errs} errors while loading. Do NOT trust this restore."
    echo "       Try the previous night's backup:  $0 --file <older backup file>"
  fi

  echo " [5/7] Applying database settings…"
  pg -d postgres -qc "ALTER DATABASE ${DB_NAME} SET search_path = vibetb, public;" >/dev/null 2>&1

  echo " [6/7] Clearing stale background jobs…"
  docker exec "${REDIS_CONTAINER}" redis-cli FLUSHDB >/dev/null 2>&1 \
    || echo "       (job queue not reachable — skipped; harmless)"

  echo " [7/7] Starting the application…"
  docker start "${API_CONTAINER}" "${WORKER_CONTAINER}" >/dev/null 2>&1
  if wait_healthy; then
    local counts
    counts="$(sanity_counts "${DB_NAME}")"
    echo
    echo "==================================================================="
    echo " RESTORE COMPLETE — the application is running."
    echo " Restored: $(echo "${counts}" | cut -d'|' -f1) clients, $(echo "${counts}" | cut -d'|' -f2) time entries, $(echo "${counts}" | cut -d'|' -f3) invoices."
    echo
    echo " Now do these three things:"
    echo "  1. Sign in and spot-check a few recent clients and invoices."
    echo "  2. Tell your staff the system was restored to ${when} —"
    echo "     anything entered after that time must be re-entered."
    echo "  3. If clients paid invoices online recently, compare the Stripe"
    echo "     dashboard against the app and record any missing payments."
    echo "==================================================================="
  else
    echo
    echo " The application did not come back up within 2 minutes."
    echo " Run: docker logs --tail 50 ${API_CONTAINER}   (or get IT help)"
    echo " The safety copy of the pre-restore data is at: ${snap}"
    exit 1
  fi
}

case "${MODE}" in
  check)   do_check ;;
  keys)    do_keys ;;
  restore) do_restore ;;
esac
