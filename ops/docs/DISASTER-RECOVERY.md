# Disaster Recovery Guide

**Who this is for:** the practice owner. Sections 1–4 need no IT background.
The step-by-step **restore methods** (5, 6, 7) get technical — hand those to
whoever helps you with computers. You just need to know which one to use.

**The single most important thing:** there are **three different
passphrases/credentials** in this system, and using the wrong one is the
#1 cause of a failed restore. This table is the key to everything below —
keep it straight:

| Credential | Length / form | Unlocks | On the kit sheet |
|---|---|---|---|
| **Backup passphrase** | 64 characters | The **external-drive** backups (`.sql.gz.gpg`) and the key bundle (`.tar.gz.gpg`) | line 1 |
| **Off-site passphrase** | short (~16 char) | The **Backblaze cloud** (Duplicati) backup | line 2 |
| **Backblaze keys** | Key ID + Application Key | Lets Duplicati *reach/download* the cloud files (this is access, not decryption) | line 3 |

The 64-char backup passphrase and the short off-site passphrase are **not the
same value** and are **not interchangeable**. Duplicati uses the off-site one.

---

## 1. How your data is protected

Your system keeps **three separate copies** of everything, automatically,
every night:

| Copy | Where | When | What it protects against |
|------|-------|------|--------------------------|
| 1. External drive | The small drive plugged into the computer (`PracticeBK`) | Every night ~2 AM | The computer breaking |
| 2. Off-site cloud | Backblaze cloud storage, encrypted | Every night | Fire, flood, theft — anything that takes out the whole office |
| 3. Client documents | Already live in Backblaze cloud storage — they are **not** on the office computer | Continuous | Everything above; documents come back automatically once the system is restored |

Both backup copies are **encrypted** — a stolen drive or cloud account is
useless without the passphrases on your Recovery Kit sheet.

**The system also tests itself.** Every night it takes the newest external-drive
backup and does a practice restore into a scratch area, then reports
`RESTORE TEST PASSED` or `FAILED` in the backup log. A backup that can't be
restored is just a file — this proves yours actually restore.

---

## 2. The Recovery Kit sheet — the one thing YOU must do

Everything above is automatic **except one thing**: the passphrases that unlock
the backups must exist somewhere that is *not* the office computer. If the
computer and the passphrases burn together, the cloud backup is unreadable — by
design (that's what makes it safe from thieves).

**Print the Recovery Packet, put it in a fireproof safe or bank safe-deposit
box, and tell one trusted person where it is.**

You can produce the packet two ways:

- **In the app (gives you the PDF):** Admin → Operations → Backup →
  **Download Recovery Packet**. It asks for your login's second-factor code
  first, because the file contains every secret. The PDF is page 1 = the kit
  sheet (all three credentials), followed by this guide.
- **On the appliance (refreshes the values):**
  `ops/scripts/generate-recovery-kit.sh` writes/refreshes
  `~/appliance-secrets/RECOVERY-KIT.txt` (the nightly staging cron runs it too,
  so the values never go stale). The app button renders that file into the PDF.

---

## 3. When something goes wrong — pick your scenario

| Your situation | Use | Roughly |
|---|---|---|
| **A.** Computer works, data is wrong (bad change, accidental delete) | **Method 5** — quick restore from the drive | 10 minutes, you can do it |
| **B.** Computer died, you have the backup drive | **Method 6** — rebuild from the drive | Half a day, IT helper |
| **C.** Fire / flood / theft — office and drive are gone | **Method 7** — rebuild from the cloud | Half a day, IT helper, needs the Recovery Kit |

Methods 6 and 7 are for whoever helps you with computers. Hand them this
document, the Recovery Kit, and (for B) the drive.

---

## 4. The monthly five-minute drill

Once a month (put it on the calendar):

1. **Test a restore** (completely safe — uses a scratch copy, touches nothing):
   ```
   ~/github-projects/Vibe-Time-Billing/ops/scripts/restore.sh --check
   ```
   You want: `RESTORE TEST PASSED`.
2. **Look at the drive:** `ls -lt /mnt/external/vibe-tb-backups/ | head -5`
   — the top file should be dated last night.
3. **Check the safe** (quarterly): the Recovery Packet is still there and still
   matches (regenerate + reprint after any passphrase change).

If either check fails, treat it like a smoke alarm beeping: fix it that week,
not "someday" — a broken backup is invisible until the day you need it.

---

# Method 5 — Quick restore from the drive (Scenario A)

*The computer and its backup drive are fine; you just need to roll the data
back to last night (or an earlier night). The application stays on the same
machine. This is the common case.*

**You need:** nothing extra. **Passphrase:** none to type — the script finds
the 64-char backup passphrase automatically from the appliance.

### Steps

1. Open a terminal on the appliance and run:
   ```sh
   ~/github-projects/Vibe-Time-Billing/ops/scripts/restore.sh
   ```
2. It shows the backup it found (last night's), asks you to type `RESTORE`,
   then does everything itself: saves a safety copy of the current data,
   stops the app, loads the backup, reapplies settings, clears stale jobs,
   restarts the app, and prints what to check.
3. To roll back **further than last night**, list the drive and pick a file:
   ```sh
   ls /mnt/external/vibe-tb-backups/
   ~/github-projects/Vibe-Time-Billing/ops/scripts/restore.sh \
     --file /mnt/external/vibe-tb-backups/vibe-tb-2026-07-10-020109.sql.gz.gpg
   ```

### After it finishes

- Sign in and spot-check a few recent clients and invoices.
- Tell staff the cutoff time — anything entered **after** the backup you chose
  must be re-entered.
- If clients paid invoices online recently, reconcile the Stripe dashboard
  against the app (payments received during the gap won't be in the restored
  data).

---

# Method 6 — Rebuild from the external drive (Scenario B)

*For the IT helper. The owner hands you the `PracticeBK` drive, the Recovery
Kit, and this document. Result: the appliance running on a fresh Ubuntu
machine with all data. Budget half a day.*

**Passphrase you'll use:** the **64-character backup passphrase** (kit line 1)
for both the database file and the key bundle. Not the off-site one.

### 6.1 Files you need (from the drive, folder `vibe-tb-backups/`)

- Newest database: `vibe-tb-<date>.sql.gz.gpg`
- Newest key bundle: `vibe-tb-keys-<date>.tar.gz.gpg`

### 6.2 Base machine

```sh
# Ubuntu 22.04+
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER          # then log out and back in
git clone https://github.com/KisaesDevLab/Vibe-Time-Billing.git \
  ~/github-projects/Vibe-Time-Billing
cd ~/github-projects/Vibe-Time-Billing
```

### 6.3 Recover the secrets and keys from the bundle

```sh
export BACKUP_KEYS_PASSPHRASE='<64-char backup passphrase from kit line 1>'
ops/scripts/restore.sh --keys /path/to/vibe-tb-keys-<newest>.tar.gz.gpg
```

That unpacks `recovered-keys-<ts>/` containing `vibe-build.env` (the complete
appliance environment file), `keys.env`, `opensign.env`, and `firm-key.seal`.
Put them in place:

```sh
mkdir -p ~/appliance-secrets && chmod 700 ~/appliance-secrets
cp recovered-keys-*/vibe-build.env ~/appliance-secrets/
cp recovered-keys-*/opensign.env  ~/appliance-secrets/ 2>/dev/null || true
cp ~/appliance-secrets/vibe-build.env /tmp/vibe-build.env
chmod 600 /tmp/vibe-build.env ~/appliance-secrets/*.env
```

### 6.4 Seed the firm-key volume — BEFORE first app start

The database's encrypted columns (including the Backblaze credentials for
client documents) are unreadable without this file:

```sh
docker volume create docker_firm-key
docker run --rm -v docker_firm-key:/data/firm-key \
  -v "$PWD/$(ls -d recovered-keys-*):/in:ro" \
  busybox sh -c 'cp /in/firm-key.seal /data/firm-key/.firm-key.seal && \
                 chmod 400 /data/firm-key/.firm-key.seal'
```

### 6.5 Build and start the appliance

```sh
docker build -t vibe-time-billing:local .
docker compose -f ops/docker/docker-compose.dev.yml up -d postgres redis mailhog
docker compose --project-name docker --env-file /tmp/vibe-build.env \
  -f ops/docker/docker-compose.local.yml up -d
```

Wait until `docker logs vibe-tb-api` shows migrations done and
`crypto boot: unsealed` (a wrong/missing seal or KMS_KEY shows a boot error
here instead — stop and fix the seal before continuing).

### 6.6 Load the database

The drive's database file is a gzipped SQL dump — `restore.sh` handles the
decrypt + load:

```sh
ops/scripts/restore.sh --file /path/to/vibe-tb-<newest>.sql.gz.gpg
```

### 6.7 E-signature stack (OpenSign)

The drive's key bundle already gave you `opensign.env`. The OpenSign
database/files are **not** on the drive (only in the off-site backup), so on a
drive-only rebuild the e-signature service comes back empty but functional —
new signatures work; historical signed PDFs live in your file storage (B2) and
are unaffected.

```sh
cp ~/appliance-secrets/opensign.env ops/docker/opensign/.env.prod
docker compose -f ops/docker/opensign/docker-compose.yml \
  --env-file ops/docker/opensign/.env.prod up -d
```

### 6.8 Finish — see §8 "After any full rebuild".

---

# Method 7 — Rebuild from the off-site cloud backup (Scenario C)

*For the IT helper. The office and the drive are gone; everything comes from
Backblaze via Duplicati. The owner hands you the Recovery Kit and this
document. Budget half a day.*

**This path is different from Method 6 in three ways** — read them first:
1. There is **no key-bundle step** (`restore.sh --keys`). Duplicati restores
   the secrets as ordinary files; you copy them into place.
2. The database file is a **`pg_restore` custom-format dump** (`.dump`), **not**
   a `.sql.gz.gpg`. `restore.sh --file` does **not** apply here — use
   `pg_restore`.
3. The OpenSign database and signed files **are** in this backup and must be
   restored.

**Credentials you'll use (all from the kit):** the **Backblaze Key ID +
Application Key** (line 3) to connect, and the **short off-site passphrase**
(line 2) to decrypt. **Not** the 64-char backup passphrase.

### 7.1 Download the backup with Duplicati

1. Install Duplicati (https://duplicati.com) on the replacement machine.
2. Choose **Restore → Restore from configuration / Direct restore from backup
   files**, storage type **B2 Cloud Storage**, and enter from the kit:
   - Bucket: `Backups-Vibe`  Folder path: `Practice`
   - Backblaze Application Key ID (line 3)
   - Backblaze Application Key (line 3)
   - **Test connection** — it should list the backup.
3. When prompted for the **encryption passphrase**, enter the **short off-site
   passphrase** (line 2). *If you get "decryption failed / wrong password," you
   are almost certainly using the 64-char backup passphrase — switch to the
   short one.*
4. Restore to a folder, e.g. `~/restore/`. You'll get:
   - `~/restore/appliance-secrets/` — `vibe-build.env`, `opensign.env` (plaintext)
   - `~/restore/appliance-backup/staging/pg/vibe_tb-<stamp>.dump` — the database
   - `~/restore/appliance-backup/staging/firm-key/current/.firm-key.seal` — the
     firm master-key seal (hidden file — use `ls -la`)
   - `~/restore/appliance-backup/staging/mongo/opensign-<stamp>.archive` — e-sign DB
   - `~/restore/appliance-backup/staging/opensign-files/current/` — signed files

### 7.2 Base machine

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER          # then log out and back in
git clone https://github.com/KisaesDevLab/Vibe-Time-Billing.git \
  ~/github-projects/Vibe-Time-Billing
cd ~/github-projects/Vibe-Time-Billing
```

### 7.3 Put the secrets in place (no bundle to unpack)

```sh
mkdir -p ~/appliance-secrets && chmod 700 ~/appliance-secrets
cp ~/restore/appliance-secrets/*.env ~/appliance-secrets/
cp ~/appliance-secrets/vibe-build.env /tmp/vibe-build.env
chmod 600 /tmp/vibe-build.env ~/appliance-secrets/*.env
```

### 7.4 Seed the firm-key volume — BEFORE first app start

```sh
docker volume create docker_firm-key
docker run --rm -v docker_firm-key:/data/firm-key \
  -v "$HOME/restore/appliance-backup/staging/firm-key/current:/in:ro" \
  busybox sh -c 'cp /in/.firm-key.seal /data/firm-key/.firm-key.seal && \
                 chmod 400 /data/firm-key/.firm-key.seal'
```

### 7.5 Build and start the appliance

```sh
docker build -t vibe-time-billing:local .
docker compose -f ops/docker/docker-compose.dev.yml up -d postgres redis mailhog
docker compose --project-name docker --env-file /tmp/vibe-build.env \
  -f ops/docker/docker-compose.local.yml up -d
```

Wait for `docker logs vibe-tb-api` to show migrations done and
`crypto boot: unsealed`.

### 7.6 Load the database — `pg_restore` (NOT restore.sh)

```sh
# Pick the NEWEST .dump in staging/pg/
docker exec -i vibe-tb-postgres pg_restore --no-owner --no-acl --clean --if-exists \
  -U vibe -d vibe_tb \
  < ~/restore/appliance-backup/staging/pg/vibe_tb-<newest>.dump

docker exec vibe-tb-postgres psql -U vibe -d postgres -c \
  "ALTER DATABASE vibe_tb SET search_path = vibetb, public;"
```

### 7.7 E-signature stack (OpenSign) — with its data

```sh
cp ~/appliance-secrets/opensign.env ops/docker/opensign/.env.prod
docker compose -f ops/docker/opensign/docker-compose.yml \
  --env-file ops/docker/opensign/.env.prod up -d
sleep 20   # let opensign-mongo come up

# Restore the e-sign database (--drop replaces the fresh empty collections)
docker exec -i opensign-mongo mongorestore --archive --drop \
  < ~/restore/appliance-backup/staging/mongo/opensign-<newest>.archive

# Restore the signed documents
docker cp ~/restore/appliance-backup/staging/opensign-files/current/. \
  opensign-server:/usr/src/app/files/
```

### 7.8 Finish — see §8 "After any full rebuild".

---

## 8. After any full rebuild (Methods 6 & 7)

1. **Confirm crypto + file access:** `docker logs vibe-tb-api` shows
   `crypto boot: unsealed`, and Admin → Files lists your folders (proves the
   Backblaze client-document credentials decrypted correctly).
2. **Re-arm the drive backups:** label the external drive `PracticeBK`, add the
   fstab line from the kit, `sudo mount -a`, then pick it in
   Admin → Operations → Backup.
3. **Re-create the nightly staging cron:** `crontab -e` →
   `30 1 * * * /home/YOUR-USERNAME/appliance-backup/stage.sh`
   (copy `stage.sh` from the off-site backup or the repo).
4. **Reinstall Duplicati** (if not already), point it at the same B2 bucket +
   off-site passphrase, run one backup to confirm.
5. **Remote access (Cloudflare tunnel):** the tunnel credentials are in the
   restored database (Admin → Operations shows status); the connector token is
   `TUNNEL_TOKEN` in `vibe-build.env`.
6. **Prove it:** `ops/scripts/restore.sh --check` must say
   `RESTORE TEST PASSED`.
7. **Reprint the Recovery Packet** if anything changed; store in the safe.

---

## 9. Quick reference — which passphrase, which command

| Task | Passphrase | Command |
|---|---|---|
| Roll data back, same machine | (none — auto) | `restore.sh` |
| Unpack the drive key bundle | 64-char (line 1) | `restore.sh --keys <bundle>` |
| Load a drive database backup | 64-char (line 1) | `restore.sh --file <...sql.gz.gpg>` |
| Connect Duplicati to Backblaze | Backblaze Key ID + Key (line 3) | Duplicati UI |
| Decrypt the off-site backup | short off-site (line 2) | Duplicati UI |
| Load an off-site database dump | (none — already decrypted) | `pg_restore ... < <...dump>` |

---

## 10. Recovery Kit sheet — blank template (for hand-copy)

```
==============================================================
  <FIRM NAME> — PRACTICE SYSTEM RECOVERY KIT      (keep in safe)
  Generated: <date>            Regenerate after any change.
==============================================================
1) BACKUP PASSPHRASE  (64-char; external drive + key bundles):
    ________________________________________________________

2) OFF-SITE PASSPHRASE  (Duplicati / Backblaze cloud decrypt):
    ________________________________________

3) BACKBLAZE KEYS  (cloud access — download the off-site backup):
    Application Key ID: ____________________________
    Application Key:    ____________________________
    Bucket: Backups-Vibe   Folder: Practice
    Account sign-in (email): _______________________
      (https://www.backblaze.com)

CLIENT DOCUMENTS: Backblaze bucket "DocumentManagement" —
    credentials are inside the database backup; they return
    automatically on restore.

EXTERNAL DRIVE: Samsung T7 1TB, label "PracticeBK",
    folder vibe-tb-backups/. fstab line:
    ________________________________________________________

WHAT TO DO: ops/docs/DISASTER-RECOVERY.md
    (github.com/KisaesDevLab/Vibe-Time-Billing)
    A. data wrong  → Method 5 (restore.sh)
    B. machine died → Method 6 (rebuild from drive)
    C. office gone  → Method 7 (rebuild from cloud)

IT / SUPPORT CONTACT: ______________________________________
==============================================================
```
