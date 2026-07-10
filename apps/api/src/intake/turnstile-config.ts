// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Turnstile secret at-rest crypto + masking. The site key is public (stored
// plaintext); the secret is kept as a KMS-encrypted envelope (same AES-GCM
// helper the messaging provider secrets use). Admin sets these in Firm
// Settings; the public intake routes decrypt the secret to verify tokens.

import { crypto as core } from '@vibe/core';

import { loadConfig } from '../config';

function key(): Buffer {
  const cfg = loadConfig();
  if (!cfg.KMS_KEY) throw new Error('KMS_KEY not configured');
  return core.resolveKey(cfg.KMS_KEY);
}

export function encryptTurnstileSecret(secret: string): string {
  return core.encryptJson({ s: secret }, key());
}

export function decryptTurnstileSecret(envelope: string): string {
  return core.decryptJson<{ s: string }>(envelope, key()).s;
}

/** Masked preview for the admin UI — never returns the full secret. */
export function maskSecret(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length <= 4 ? '****' : `${s.slice(0, 2)}…${s.slice(-2)}`;
}
