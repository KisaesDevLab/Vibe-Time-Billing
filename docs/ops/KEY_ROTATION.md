# Key Rotation Runbook

## When to rotate

- **MFK rotation** — annually as a hygiene baseline, or immediately after any suspected compromise of the appliance host. Triggered manually by an operator with `crypto:rotate` permission.
- **KEK rotation (sealed-on-disk mode)** — when `/data/.firm-key.seal` may have been copied off-box. Rotate the seal file; T-DEKs and MFK are unchanged.
- **Passphrase rotation (admin-passphrase mode)** — anytime the passphrase may have been shoulder-surfed, written down, or shared with someone who has since departed.

There is no automatic rotation. All paths below are operator-initiated.

## Pre-rotation checklist

1. Confirm the appliance is `unlocked` — `GET /api/staff/admin/unlock/status` returns `{"locked": false, ...}`.
2. Take a fresh DB snapshot via `pg_dump --schema=vibetb` (see `docs/ops/SCHEMA_LAYOUT.md`).
3. Take a fresh copy of `/data/.firm-key.seal` if running sealed-on-disk mode. Store offline.
4. Confirm no active jobs are encrypting/decrypting — pause workers briefly if rotation involves the MFK.

## MFK rotation (sealed-on-disk)

```
1. Operator with crypto:rotate calls (future) POST /api/staff/admin/rotate-mfk.
   Internally: FirmKeyManager.rotateMFK(firmId).
2. Manager generates new MFK, re-wraps the sentinel + the new MFK with the
   existing KEK, persists the new envelope row.
3. Caller receives {oldMfk, newMfk} for the duration of the call.
4. Caller iterates every thread row and rewraps t_dek_wrapped:
       unwrapped = decrypt(thread.t_dek_wrapped, oldMfk)
       thread.t_dek_wrapped = wrap(unwrapped, newMfk)
   Done in transaction batches, ideally with read-only mode on messaging
   during the swap.
5. zero(oldMfk) on the caller's side; the new MFK is now live in
   FirmKeyManager.liveKeys.
```

**Status today**: the rotateMFK primitive is implemented and tested. The end-to-end "rotate the MFK and re-wrap every T-DEK" admin endpoint is **not** wired — it's queued for the operational hardening pass. To rotate today, run the same logic from a maintenance script with database connectivity.

## MFK rotation (admin-passphrase mode)

The crypto package currently rejects `rotateMFK` calls in admin-passphrase mode (`'rotateMFK in admin-passphrase mode requires the passphrase; use rotateMFKWithPassphrase'`).

To rotate in admin-passphrase mode:

1. Operator locks the appliance: `POST /api/staff/admin/unlock/lock` (with `crypto:unlock`).
2. Run a one-shot maintenance script that:
   - Calls `recoverKek(metadata, oldPassphrase)` to recover the existing KEK.
   - Calls `unseal` to load the existing MFK in memory.
   - Generates a new salt + Argon2id-derives a new KEK from the new passphrase.
   - Wraps the existing MFK with the new KEK.
   - Updates `firm_key_envelope.wrapped_mfk` + `kek_metadata`.
3. Operator unseals with the new passphrase via `POST /api/staff/admin/unlock`.

The thread T-DEKs are unaffected because the MFK didn't change — only the KEK that wraps it.

## KEK rotation (sealed-on-disk only)

1. Lock the appliance (`POST /api/staff/admin/unlock/lock`).
2. From the host: read `/data/.firm-key.seal` → that's the old KEK. Unwrap the existing MFK from `firm_key_envelope.wrapped_mfk`.
3. Generate a new 32-byte KEK. Write it to `/data/.firm-key.seal` (mode 0400). Optionally archive the old file in a sealed location for disaster recovery.
4. Rewrap the MFK with the new KEK and overwrite `wrapped_mfk`.
5. Restart the API; sealed-on-disk unseal picks up the new KEK transparently.

## Lost passphrase / lost seal file

This is **unrecoverable**. The encrypted content (message bodies primarily) is mathematically inaccessible without the KEK chain. There is no backdoor.

Mitigations to put in place ahead of time:

- **Sealed-on-disk:** keep an offline copy of `/data/.firm-key.seal` in a sealed envelope or hardware vault.
- **Admin-passphrase:** keep the passphrase in two places (e.g., a sealed envelope in the partner's office safe + a password manager owned by the firm's principal). Never store it on the same host as the database.

If both keys are truly lost, the appliance can still be restored to a usable state by:

1. `DELETE FROM vibetb.firm_key_envelope`.
2. Restart the API; `bootCrypto` detects the missing row and bootstraps a fresh envelope.
3. Every existing `thread.t_dek_wrapped` becomes garbage — those messages are permanently inaccessible.
4. New threads created post-restore work normally.

Document any lost-key incident in the audit log via the existing `RESTORE_DATABASE` action.

## After-rotation verification

1. Restart the API and confirm `crypto boot: unsealed` or `crypto boot: bootstrapped envelope` in the logs.
2. `GET /api/staff/admin/unlock/status` returns `{"locked": false}`.
3. Send one test message via the staff UI and read it back from the portal UI — round-trip confirms the active T-DEK is functional.
4. Confirm a recent `audit_log` row records the rotation event.

## Where the code lives

- `packages/crypto/src/firm-key-manager.ts` — `rotateMFK`, `forget`
- `apps/api/src/crypto/manager.ts` — process-wide singleton + `resetFirmKeyManagerForTests`
- `apps/api/src/crypto/boot.ts` — `bootCrypto`, `getApplianceLockState`
- `apps/api/src/admin/unlock.ts` — `/status`, `/unlock`, `/lock` operator surface
