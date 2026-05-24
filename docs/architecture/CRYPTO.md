# Envelope Encryption Architecture

TB encrypts message bodies and any other sensitive at-rest content using a three-tier key hierarchy. Plaintext keys never leave the API process's memory.

## Key hierarchy

```
KEK  (Key Encryption Key)
 │
 │  wraps
 ▼
MFK  (Master Firm Key, 32 bytes, in-memory only)
 │
 │  wraps
 ▼
T-DEK  (per-Thread Data Encryption Key, 32 bytes)
 │
 │  encrypts
 ▼
Message body / future content
```

### KEK — Key Encryption Key

Two derivation modes, picked per firm via `firm_config.unlock_mode`:

- **`sealed-on-disk`** (default). 32 random bytes written to `/data/.firm-key.seal` with mode 0400. The directory is created with mode 0700. On every API boot the file is read and used as the KEK directly. Zero operator action.
- **`admin-passphrase`** (opt-in). KEK = `Argon2id(passphrase, salt, params)`. The salt + Argon2id parameters live in `firm_key_envelope.kek_metadata`. The passphrase is never persisted; the operator POSTs it to `/api/staff/admin/unlock` on every boot.

### MFK — Master Firm Key

32 random bytes, generated once per firm at bootstrap. Stored only as `firm_key_envelope.wrapped_mfk` — `XChaCha20-Poly1305(KEK, MFK)`. Plaintext MFK lives in `FirmKeyManager`'s in-memory map and is zeroed when `forget()` runs or the process exits.

### T-DEK — per-Thread Data Encryption Key

Each `thread` row carries `t_dek_wrapped` — `XChaCha20-Poly1305(MFK, T-DEK)`. The plaintext T-DEK is unwrapped on demand inside a single function scope (`engagement-messaging/thread-crypto.ts`) and zeroed immediately after the encrypt or decrypt operation.

Per-thread DEK isolation lets us rotate a single thread's key without re-wrapping the entire history — and it caps the blast radius of any single key compromise.

## Sentinel

`firm_key_envelope.sentinel_ciphertext` = `XChaCha20-Poly1305(MFK, "vibe-tb-firm-key-sentinel-v1")`.

At unseal we decrypt the sentinel and compare the plaintext byte-for-byte to the known constant. Mismatch means either the envelope was tampered with or the wrong MFK was recovered; we refuse to mount the routers.

## Cipher choices

- **XChaCha20-Poly1305** (via `@noble/ciphers`). 24-byte random nonce makes nonce-reuse statistically irrelevant across the appliance's lifetime; AEAD tag catches tampering. Pure-JS; no native binding required.
- **Argon2id** (via `argon2` npm package). Default params: time_cost=4, memory_cost=65536 (64 MiB), parallelism=1, hashLength=32.

## Process lifecycle

```
boot
 ├── load firm_config.unlock_mode for the single firm
 ├── if sealed-on-disk:  read /data/.firm-key.seal → KEK → unwrap MFK → verify sentinel → unlocked
 ├── if admin-passphrase: leave locked. /api/staff/admin/unlock accepts passphrase.
 ├── lock middleware returns 503 on every route until unlocked
 │                                  (allowlist: /health/*, /metrics, /api/auth/*, /api/staff/admin/unlock/*)
 └── once unlocked, the per-firm MFK lives in FirmKeyManager.liveKeys until process exit

per-request encrypt
 ├── unwrap T-DEK from thread.t_dek_wrapped using MFK
 ├── XChaCha20-Poly1305 encrypt the plaintext
 ├── zero the plaintext T-DEK
 └── persist ciphertext in message.body_ciphertext

per-request decrypt (single message or batch)
 ├── unwrap T-DEK once
 ├── decrypt each ciphertext under the same unwrapped key (batchDecryptForThread)
 ├── zero the plaintext T-DEK
 └── return plaintexts to the caller
```

## What is and isn't protected

| Asset                                | Encrypted at rest?                                              |
| ------------------------------------ | --------------------------------------------------------------- |
| Message body bytes                   | Yes — `XChaCha20-Poly1305(T-DEK, body)`                         |
| Message excerpt (first 80 chars)     | No — kept plaintext for list-view performance                   |
| Message attachments (the file blobs) | Files v2 handles its own storage; this codec doesn't wrap files |
| Thread title                         | No — workflow metadata                                          |
| Client request title/body            | No — workflow metadata                                          |
| MFK on disk                          | Always wrapped by KEK                                           |
| MFK in memory                        | Plaintext, in `FirmKeyManager.liveKeys` map                     |
| TOTP secrets                         | AES-256-GCM via `KMS_KEY` (separate codec, predates this work)  |

## Threat model

| Threat                                        | Mitigation                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Database dump leaks                           | Ciphertext only; KEK lives on a separate volume (`/data/.firm-key.seal`) or only in operator's head (admin-passphrase)          |
| Filesystem snapshot leaks both DB and `/data` | sealed-on-disk does not protect against this — operator must enable admin-passphrase if `/data` and the DB share trust boundary |
| Compromised API process memory                | All keys are recoverable — accepted; perimeter is the appliance                                                                 |
| Compromised operator passphrase               | Rotate via `rotateMFK` + future re-wrap of all T-DEKs                                                                           |

## Where to look in the code

- `packages/crypto/` — `EnvelopeCodec`, `FirmKeyManager`
- `apps/api/src/crypto/` — DB-backed store, singleton manager, boot orchestrator
- `apps/api/src/admin/unlock.ts` — operator unlock/lock surface
- `apps/api/src/engagement-messaging/thread-crypto.ts` — per-thread encrypt/decrypt helpers
- `packages/db/migrations/0058_firm_config_and_key_envelope.sql` — persistence schema

See also: `docs/architecture/MESSAGING_VAULT.md`, `docs/ops/KEY_ROTATION.md`.
