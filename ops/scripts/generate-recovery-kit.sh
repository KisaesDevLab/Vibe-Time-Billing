#!/usr/bin/env bash
# =============================================================================
# generate-recovery-kit.sh — assemble the appliance Recovery Kit sheet.
#
# Collects the THREE credentials a disaster recovery needs — which live in
# three different places — into one operator-held sheet:
#
#   1. Backup passphrase (64-char)  ← appliance env (vibe-build.env)
#   2. Off-site passphrase          ← Duplicati config (its own sqlite)
#   3. Backblaze access keys        ← Duplicati config (B2 target credentials)
#
# Writes ~/appliance-secrets/RECOVERY-KIT.txt (mode 0600). The admin-UI
# "Download Recovery Packet" button renders this file + the recovery guide into
# a printable PDF; the nightly staging cron re-runs this so the values never go
# stale. To get the PDF itself, use Admin → Operations → Backup (or open this
# file and ops/docs/DISASTER-RECOVERY.md and print them).
#
# Run by hand any time. It reports WHERE it wrote and WHICH credentials were
# found — never the secret values themselves.
#
# Environment overrides: SECRETS_DIR (~/appliance-secrets),
# ENV_FILE ($SECRETS_DIR/vibe-build.env),
# DUPLICATI_DB (~/.config/Duplicati/Duplicati-server.sqlite).
# =============================================================================

set -uo pipefail

SECRETS_DIR="${SECRETS_DIR:-$HOME/appliance-secrets}"
ENV_FILE="${ENV_FILE:-$SECRETS_DIR/vibe-build.env}"
DUPLICATI_DB="${DUPLICATI_DB:-$HOME/.config/Duplicati/Duplicati-server.sqlite}"
OUT="${SECRETS_DIR}/RECOVERY-KIT.txt"

command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required" >&2; exit 1; }
mkdir -p "${SECRETS_DIR}"; chmod 700 "${SECRETS_DIR}" 2>/dev/null || true

# The assembly runs in python: reads the env file + Duplicati sqlite, writes the
# sheet atomically at 0600. Secret VALUES are never echoed to stdout.
ENV_FILE="${ENV_FILE}" DUPLICATI_DB="${DUPLICATI_DB}" OUT="${OUT}" python3 - <<'PY'
import os, sqlite3, datetime, stat, tempfile
from urllib.parse import urlparse, parse_qs

env_file = os.environ["ENV_FILE"]
dup_db   = os.environ["DUPLICATI_DB"]
out      = os.environ["OUT"]

# 1) appliance env → backup passphrase
env = {}
try:
    with open(env_file) as f:
        for line in f:
            line = line.rstrip("\n")
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1); env[k] = v
except FileNotFoundError:
    pass
backup_pass = env.get("BACKUP_KEYS_PASSPHRASE", "")

# 2+3) Duplicati sqlite → off-site passphrase + B2 access
dup_pass = b2_id = b2_key = bucket = folder = ""
try:
    db = sqlite3.connect(dup_db)
    tgt = next((r[0] for r in db.execute("SELECT TargetURL FROM Backup ORDER BY ID LIMIT 1")), "")
    dup_pass = next((v for n, v in db.execute("SELECT Name,Value FROM Option WHERE BackupID=1") if n == "passphrase"), "")
    if tgt:
        p = urlparse(tgt); q = parse_qs(p.query)
        bucket = p.hostname or ""
        folder = (p.path or "").strip("/")
        b2_id  = (q.get("auth-username") or q.get("b2-accountid") or [""])[0]
        b2_key = (q.get("auth-password") or q.get("b2-applicationkey") or [""])[0]
except Exception:
    pass

# fstab line for the external drive, if present
fstab = "(fstab line not found — drive label is PracticeBK)"
try:
    with open("/etc/fstab") as f:
        for l in f:
            if "PracticeBK" in l:
                fstab = l.strip(); break
except Exception:
    pass

today = datetime.date.today().isoformat()
kit = f"""==============================================================
  PRACTICE SYSTEM RECOVERY KIT                    (KEEP IN SAFE)
  Generated: {today}     Regenerate + reprint after any change.
  PRINT THIS. Anyone holding it can read your backups —
  treat it like a signed blank check.
==============================================================

1) BACKUP PASSPHRASE  (64-char; UNLOCKS THE EXTERNAL-DRIVE
   backups .sql.gz.gpg AND the key bundles .tar.gz.gpg):
     {backup_pass or '(NOT SET)'}

2) OFF-SITE PASSPHRASE  (DECRYPTS the Backblaze/Duplicati
   cloud backup — this is NOT the 64-char one above):
     {dup_pass or '(NOT SET)'}

3) BACKBLAZE KEYS  (cloud ACCESS — lets Duplicati download the
   off-site files; an application-key pair, not a passphrase):
     Application Key ID: {b2_id or '(stored only in Duplicati config)'}
     Application Key:    {b2_key or '(stored only in Duplicati config)'}
     Bucket: {bucket or '?'}   Folder: {folder or '?'}
     Account sign-in (email): ______________________________
       (fill in by hand — https://www.backblaze.com)

CLIENT DOCUMENTS: Backblaze bucket "DocumentManagement".
   Credentials live inside the database backup — they return
   automatically on restore. Nothing to store here.

EXTERNAL DRIVE: Samsung T7 1TB, label "PracticeBK",
   folder vibe-tb-backups/. fstab line for a rebuilt machine:
   {fstab}

WHAT TO DO IN A DISASTER — ops/docs/DISASTER-RECOVERY.md
   (github.com/KisaesDevLab/Vibe-Time-Billing):
     A. Data wrong, computer fine -> Method 5 (restore.sh)
     B. Computer died, drive OK   -> Method 6 (rebuild from drive)
     C. Office gone               -> Method 7 (rebuild from cloud)
        (IT: install Duplicati, connect with #3, decrypt with #2)

IT / SUPPORT CONTACT: ______________________________________

=============================================================="""

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out))
with os.fdopen(fd, "w") as f:
    f.write(kit + "\n")
os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
os.replace(tmp, out)

missing = [n for n, v in (("backup passphrase", backup_pass),
                          ("off-site passphrase", dup_pass),
                          ("backblaze key", b2_id)) if not v]
print("RECOVERY-KIT.txt written (values not shown).",
      "MISSING: " + ", ".join(missing) if missing else "All three credentials present.")
PY
rc=$?
[[ $rc -eq 0 ]] || { echo "ERROR: kit assembly failed" >&2; exit $rc; }
echo "  -> ${OUT}"
