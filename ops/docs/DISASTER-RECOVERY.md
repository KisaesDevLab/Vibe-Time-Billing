# Disaster Recovery Guide

**Who this is for:** the practice owner. No IT background needed for the
first half. The "computer died" scenarios include pages written for
whoever helps you with computers — you don't need to understand them,
you just need to know they exist and hand them over.

---

## 1. How your data is protected

Your system keeps **three separate copies** of everything, automatically,
every night:

| Copy | Where | When | What it protects against |
|------|-------|------|--------------------------|
| 1. External drive | The small drive plugged into the computer (`PracticeBK`) | Every night ~2 AM | The computer breaking |
| 2. Off-site cloud | Backblaze cloud storage, encrypted | Every night | Fire, flood, theft — anything that takes out the whole office |
| 3. Client documents | Already live in Backblaze cloud storage — they are **not** on the office computer | Continuous | Everything above; documents come back automatically once the system is restored |

Both backup copies are **encrypted** — if someone steals the drive, they
get nothing without the passphrases on your Recovery Kit sheet.

**The system also tests itself.** Every night it takes the newest backup
and does a practice restore into a scratch area, then reports
`RESTORE TEST PASSED` or `FAILED` in the backup log. A backup that can't
be restored is just a file — this proves yours actually restore.

---

## 2. The Recovery Kit sheet — the one thing YOU must do

Everything above is automatic **except one thing**: the passphrases that
unlock the backups must exist somewhere that is *not* the office
computer. If the computer and the passphrases burn together, the cloud
backup is unreadable — by design (that's what makes it safe from
thieves).

**Print the Recovery Kit sheet, put it in a fireproof safe or bank
safe-deposit box, and tell one trusted person where it is.**

The sheet lives at `~/appliance-secrets/RECOVERY-KIT.txt` on the
appliance (your administrator can regenerate it any time). It contains:

- The **backup passphrase** (unlocks the external-drive backups and key bundles)
- The **off-site passphrase** (unlocks the Backblaze cloud backup)
- The **Backblaze sign-in** (account for cloud backups and client documents)
- Where each backup lives and which one to use when

> Template at the bottom of this document if you prefer to copy it by hand.

---

## 3. When something goes wrong — pick your scenario

### Scenario A — "The computer works, but the data is wrong"

*Examples: a bad bulk change, records mysteriously wrong or missing since
yesterday.*

**What you need:** nothing extra — the computer and its backup drive.

Open a terminal on the appliance and run:

```
~/github-projects/Vibe-Time-Billing/ops/scripts/restore.sh
```

The script talks you through it in plain English. It shows which backup
it found (last night's, normally), saves a safety copy of the current
data first, asks you to type `RESTORE`, and does everything else itself
— including restarting the application and telling you what to check
afterwards. Ten minutes, start to finish.

To go back further than last night, list the drive and pick a file:

```
ls /mnt/external/vibe-tb-backups/
~/github-projects/Vibe-Time-Billing/ops/scripts/restore.sh --file /mnt/external/vibe-tb-backups/vibe-tb-2026-07-10-020109.sql.gz.gpg
```

**What you lose:** anything entered after the backup you chose. Tell
your staff the cutoff time; they re-enter that day's work.

### Scenario B — "The computer died, but I have the backup drive"

**What you need:** the external drive, the Recovery Kit sheet, a
replacement computer, and someone comfortable with computers (an IT
helper, or maintainer support).

**Your part:** hand your IT helper the drive, the Recovery Kit sheet,
and section 5 of this document. Everything they need is written there,
step by step. Budget half a day.

### Scenario C — "Fire / flood / theft — the office is gone"

**What you need:** the Recovery Kit sheet (this is why it lives in the
safe, not the office) and an IT helper.

Same as scenario B, except the backups are downloaded from Backblaze
first using the off-site passphrase and Backblaze sign-in from the kit
sheet. The off-site backup contains everything the drive had — including
the settings and keys — plus the e-signature system's data. Client
documents were never in the office; they reconnect automatically.

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
3. **Check the safe** (quarterly): the Recovery Kit sheet is still there
   and still matches (regenerate it after any passphrase change).

If either check fails, treat it like a smoke alarm beeping: fix it that
week, not "someday" — a broken backup is invisible until the day you
need it.

---

## 5. Full rebuild — for the IT helper

*The owner hands you: the external drive (scenario B) or the Recovery
Kit sheet (scenario C), and this page. The result is the practice
management appliance running on a fresh Ubuntu machine with all data.*

### 5.1 Get the backup files

- **Scenario B:** plug in the drive; you need the newest
  `vibe-tb-<date>.sql.gz.gpg` (database) and
  `vibe-tb-keys-<date>.tar.gz.gpg` (keys/settings) from
  `vibe-tb-backups/`.
- **Scenario C:** install [Duplicati](https://duplicati.com), connect it
  to the B2 bucket named on the kit sheet (Backblaze sign-in on the
  sheet), and restore the latest snapshot using the off-site passphrase.
  That yields `appliance-backup/staging/` (database dumps, e-sign data,
  firm-key) and `appliance-secrets/` (env files, OpenSign env, the kit
  sheet itself).

### 5.2 Base machine

```sh
# Ubuntu 22.04+, then:
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # re-login
git clone https://github.com/KisaesDevLab/Vibe-Time-Billing.git ~/github-projects/Vibe-Time-Billing
cd ~/github-projects/Vibe-Time-Billing
```

### 5.3 Recover secrets and keys

```sh
# Backup passphrase from the kit sheet:
export BACKUP_KEYS_PASSPHRASE='<from kit sheet>'
ops/scripts/restore.sh --keys /path/to/vibe-tb-keys-<newest>.tar.gz.gpg
```

That produces `recovered-keys-<ts>/` containing `vibe-build.env` (the
complete appliance environment file), `keys.env` (core secrets), and
`firm-key.seal` (the firm's master key file). Then:

```sh
mkdir -p ~/appliance-secrets && chmod 700 ~/appliance-secrets
cp recovered-keys-*/vibe-build.env ~/appliance-secrets/
cp recovered-keys-*/opensign.env  ~/appliance-secrets/ 2>/dev/null || true  # e-sign env, if present
cp ~/appliance-secrets/vibe-build.env /tmp/vibe-build.env
chmod 600 /tmp/vibe-build.env ~/appliance-secrets/*.env
```

(Scenario C: the same files are directly in the restored
`appliance-secrets/`; the seal is in `staging/firm-key/current/`.)

### 5.4 Seed the firm key volume — BEFORE first app start

The database's encrypted columns (including the Backblaze credentials
for client documents) are unreadable without this file:

```sh
docker volume create docker_firm-key
docker run --rm -v docker_firm-key:/data/firm-key -v "$PWD/recovered-keys-<ts>:/in:ro" \
  busybox sh -c 'cp /in/firm-key.seal /data/firm-key/.firm-key.seal && chmod 400 /data/firm-key/.firm-key.seal'
```

### 5.5 Build and start the appliance

```sh
docker build -t vibe-time-billing:local .
docker compose -f ops/docker/docker-compose.dev.yml up -d postgres redis mailhog
docker compose --project-name docker --env-file /tmp/vibe-build.env \
  -f ops/docker/docker-compose.local.yml up -d
```

Wait for `docker logs vibe-tb-api` to show migrations done, then restore
the database:

```sh
ops/scripts/restore.sh --file /path/to/vibe-tb-<newest>.sql.gz.gpg
```

Confirm the api log shows `crypto boot: unsealed` (wrong/missing seal or
KMS_KEY shows a boot error instead) and that Admin → Files lists folders
(proves Backblaze document access works).

### 5.6 E-signature stack (OpenSign)

```sh
cp ~/appliance-secrets/opensign.env ops/docker/opensign/.env.prod   # or restore it from the off-site backup
docker compose -f ops/docker/opensign/docker-compose.yml --env-file ops/docker/opensign/.env.prod up -d
# Scenario C: also restore its database + files from staging/:
docker exec -i opensign-mongo mongorestore --archive < staging/mongo/opensign-<newest>.archive
docker cp staging/opensign-files/current/. opensign-server:/usr/src/app/files/
```

### 5.7 Re-arm the protections

1. External drive: label `PracticeBK`, add the fstab line from the kit
   sheet, `sudo mount -a`, pick it in Admin → Operations → Backup.
2. Re-create the staging cron: `crontab -e` →
   `30 1 * * * /home/<user>/appliance-backup/stage.sh` (copy
   `stage.sh` from the off-site backup or the repo's ops docs).
3. Reinstall Duplicati, point it at the same B2 bucket + passphrase, and
   run one backup to confirm.
4. Remote access (Cloudflare tunnel): the tunnel credentials are inside
   the restored database — Admin → Operations shows tunnel status; the
   connector token is in `vibe-build.env` (`TUNNEL_TOKEN`).
5. Run `ops/scripts/restore.sh --check` — it must say PASSED.
6. Regenerate the Recovery Kit sheet if anything changed; print; safe.

---

## 6. Recovery Kit sheet — template

```
==============================================================
  <FIRM NAME> — PRACTICE SYSTEM RECOVERY KIT      (keep in safe)
  Generated: <date>            Regenerate after any change.
==============================================================
BACKUP PASSPHRASE (external drive + key bundles):
    ________________________________________________

OFF-SITE (Duplicati/Backblaze) PASSPHRASE:
    ________________________________________________

BACKBLAZE ACCOUNT:  email ______________________________
    sign-in at https://www.backblaze.com
    off-site backup bucket: ____________________
    client documents bucket: ___________________

WHERE THE BACKUPS ARE:
    External drive "PracticeBK" → folder vibe-tb-backups/
    Cloud: Duplicati backup in the bucket above

WHAT TO DO: follow ops/docs/DISASTER-RECOVERY.md in the
    software (github.com/KisaesDevLab/Vibe-Time-Billing)
    Scenario A: data wrong  → run restore.sh on the appliance
    Scenario B: machine died → hand drive + this sheet to IT
    Scenario C: office gone  → hand this sheet to IT

IT / SUPPORT CONTACT: ______________________________________
==============================================================
```
