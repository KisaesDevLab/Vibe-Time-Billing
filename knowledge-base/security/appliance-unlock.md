---
title: 'Appliance unlock & the firm key'
slug: appliance-unlock
category: security
audience: staff
tags: ['security', 'unlock', 'passphrase', 'firm key', 'crypto']
---

# Unlocking the appliance

All of a firm's sensitive content — secure message threads and stored secrets such as storage credentials and Cloudflare tunnel tokens — is encrypted with the firm's Master Firm Key (MFK). The MFK is never stored in the clear; it's held wrapped in the database and only unwrapped into process memory when the appliance is "unlocked." Until then, encrypted data cannot be read.

## Fields

- **Unlock mode.** Either **Sealed on disk** (default) or **Admin passphrase**, shown in admin under **Security · Unlock mode**.
- **Sealed on disk.** A key-encryption key (KEK) is stored on the appliance volume (default path `/data/.firm-key.seal`, restrictive permissions). At boot the API reads it and unseals the MFK automatically — no operator action.
- **Admin passphrase.** The KEK is derived from an operator passphrase via Argon2id. The MFK can only be unwrapped when someone enters the passphrase; nothing on disk alone can unlock the appliance.

## Steps

1. Boot the appliance. On every API start it reads `unlock_mode` and either auto-unseals (sealed-on-disk) or stays locked (admin-passphrase).
2. In admin-passphrase mode, check status with `GET /api/staff/admin/unlock/status`. A locked appliance reports `locked: true`.
3. Unlock with `POST /api/staff/admin/unlock` and body `{ "passphrase": "..." }`. The first call (no envelope yet) bootstraps the envelope; later calls unseal the existing one.
4. On success the appliance serves normal traffic.
5. To relock manually, an operator with the `crypto:unlock` permission sends `POST /api/staff/admin/unlock/lock` — this forgets the in-memory MFK.

## What you'll see

- **While locked**, every route except a small allowlist returns HTTP 503 `appliance_locked`. The allowlist covers health probes, `/metrics`, the unlock surface, and `/api/auth`.
- **Wrong passphrase** returns HTTP 401 `unlock_failed` (a sentinel is verified after unwrap; a wrong passphrase never yields a usable key).
- **Rate limiting.** Unlock attempts are limited per IP (3 per 5 minutes; exceeding triggers a 15-minute backoff with HTTP 429 `rate_limited`).

## Tips

- Migrate from **Sealed on disk** to **Admin passphrase** in admin under **Security · Unlock mode** → **Switch to admin-passphrase** (passphrase ≥12 chars + acknowledgement). This is **one-way** and requires `crypto:rotate`.
- In admin-passphrase mode the operator must enter the passphrase at every boot. If it's lost, encrypted firm data is unrecoverable — store it safely.
- Sealed-on-disk is convenient for unattended reboots but offers less protection if the disk itself is compromised, since the KEK lives beside the data.
