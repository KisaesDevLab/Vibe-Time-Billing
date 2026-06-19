---
title: 'Security model overview'
slug: security-model
category: security
audience: staff
tags: ['security', 'encryption', 'isolation']
---

# Security model

Vibe Practice Management is a self-hosted appliance, so the firm holds all of its own data. The security model is built around several layers that work together: envelope encryption for sensitive content, strong password and token hashing, strict separation between the staff app and the client portal, CSRF protection on every mutating request, an append-only audit log, and role-based access control.

## What you'll see

- **Envelope encryption.** Each firm has one 32-byte Master Firm Key (MFK). The MFK never wraps content directly; it wraps smaller data-encryption keys (DEKs). A secure message thread has its own per-thread DEK, used to encrypt messages and stored wrapped by the MFK. Stored secrets (storage credentials, Cloudflare tunnel tokens) are wrapped the same way. Decryption unwraps the DEK in memory, decrypts, then zeroes the plaintext key.
- **Authenticated encryption.** Every encrypted blob uses XChaCha20-Poly1305 with a random 24-byte nonce; tampered or wrong-key data fails closed.
- **Argon2id passwords.** Staff passwords are stored as argon2id digests, never plaintext (minimum 12 characters). Magic-link sign-in remains available alongside passwords.
- **Token hashing at rest.** Session, magic-link, and OTP tokens are hashed with SHA-256. API/MCP tokens are hashed with SHA-256 and looked up by hash — the raw token is shown once and never stored.
- **Cross-realm session isolation.** The staff app and portal use distinct cookie names and distinct JWT signing keys; the API refuses to start if the two secrets match. A staff session is never valid in the portal and vice versa.
- **CSRF protection.** Session cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` over HTTPS. Mutating requests must also carry a matching `x-csrf-token` header (double-submit), compared in constant time.
- **Second factor for staff.** Every staff user has at least one second factor (passkey, TOTP, email OTP, or SMS OTP), challenged after both magic-link and password sign-in. Recovery codes are generated when TOTP is enrolled and shown once.
- **Step-up re-verification.** Sensitive actions require a fresh step-up within the last 30 minutes; higher-risk money actions re-prompt on the spot.
- **Append-only audit log.** Every mutation writes an `audit_log` row, and the database role cannot UPDATE or DELETE those rows.
- **RBAC.** Access is gated by permission keys; the admin role holds every permission, other roles a subset.

## Tips

- Treat the MFK passphrase (in admin-passphrase mode) as your single most important secret — there is no recovery if it's lost.
- Brute-force protection is layered: failed step-up/TOTP attempts are rate-limited in Redis, and unlock attempts are rate-limited by IP.
- Security response headers (HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a strict CSP, and a Permissions-Policy) are sent on both surfaces.
