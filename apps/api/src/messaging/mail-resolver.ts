// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm-scoped loader for a firm's DB-backed EMAIL provider (configured in
// Admin → Messaging, encrypted at rest under KMS_KEY). Mirrors
// ./sms-resolver.ts: it decrypts with @vibe/core directly (no zod / app
// config import) and builds the provider from the ../mail/provider
// helpers. Returns null when the firm has no DB config (caller falls back
// to env), KMS_KEY is unset, the config can't decrypt, or the provider
// isn't usable (e.g. SES, which has no provider helper yet).
//
// This closes the gap where the Admin → Messaging email config was saved
// and test-sendable but never applied to real outbound mail — the live
// mailer was built once from env vars and never consulted the DB config
// (SMS already had this wrap; email did not).

import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';

import { crypto as core } from '@vibe/core';
import type { Database } from '@vibe/db';
import { firmSettings, firms } from '@vibe/db/schema';

import {
  createEmailItProvider,
  createPostmarkProvider,
  createResendProvider,
  createSmtpMailProvider,
  type MailAttachment,
  type MailMessage,
  type MailProvider,
} from '../mail/provider';

interface StoredEmailConfig {
  provider: 'smtp' | 'postmark' | 'resend' | 'ses' | 'emailit';
  from?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  token?: string;
  apiKey?: string;
}

export async function loadFirmMailProvider(
  db: Database,
  firmId: string,
  log: Logger,
  opts?: { emailitStashAttachmentUrl?: (att: MailAttachment) => string },
): Promise<MailProvider | null> {
  const [row] = await db
    .select({ enc: firmSettings.mailConfigEncrypted })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (!row?.enc) return null; // no DB config → caller uses env fallback
  const keyRaw = process.env['KMS_KEY'];
  if (!keyRaw) {
    log.warn({ firmId }, 'mail config present but KMS_KEY unset; cannot decrypt');
    return null;
  }
  let cfg: StoredEmailConfig;
  try {
    cfg = core.decryptJson<StoredEmailConfig>(row.enc, core.resolveKey(keyRaw));
  } catch (err) {
    log.warn({ err, firmId }, 'mail config decrypt failed');
    return null;
  }
  try {
    if (cfg.provider === 'smtp' && cfg.host && cfg.from) {
      return createSmtpMailProvider(
        {
          host: cfg.host,
          port: cfg.port ?? 587,
          secure: cfg.secure,
          user: cfg.user,
          pass: cfg.pass,
          from: cfg.from,
        },
        log,
      );
    }
    if (cfg.provider === 'postmark' && cfg.token && cfg.from) {
      return createPostmarkProvider({ token: cfg.token, from: cfg.from }, log);
    }
    if (cfg.provider === 'resend' && cfg.apiKey && cfg.from) {
      return createResendProvider({ apiKey: cfg.apiKey, from: cfg.from }, log);
    }
    if (cfg.provider === 'emailit' && cfg.apiKey && cfg.from) {
      return createEmailItProvider(
        {
          apiKey: cfg.apiKey,
          from: cfg.from,
          stashAttachmentUrl: opts?.emailitStashAttachmentUrl,
        },
        log,
      );
    }
    // SES has no provider helper yet; fall back to env rather than silently drop.
    log.warn({ firmId, provider: cfg.provider }, 'mail provider not usable; using env fallback');
    return null;
  } catch (err) {
    log.warn({ err, firmId }, 'mail provider build failed');
    return null;
  }
}

const FIRM_MAIL_TTL_MS = 60_000;

/**
 * Wrap a base (env-configured) MailProvider so every send first tries the
 * firm's DB-saved provider (Admin → Messaging) — the same config the "test
 * email" button uses — and falls back to the base provider only when no
 * usable DB config exists. Single-firm appliance: resolves the lone firm
 * (mirrors wrapSmsWithFirmConfig / loadEmailBranding). Resolution is cached
 * briefly so high-volume sends don't decrypt per message; an admin config
 * change takes effect within the TTL.
 */
export function wrapMailWithFirmConfig(
  base: MailProvider,
  deps: {
    db: Database | null;
    log: Logger;
    /** EmailIt URL-attachment stash (MAIL_EMAILIT_ATTACHMENT_MODE=url). */
    emailitStashAttachmentUrl?: (att: MailAttachment) => string;
  },
): MailProvider {
  let cached: MailProvider | null = null;
  let cachedAt = 0;
  async function resolve(): Promise<MailProvider> {
    if (!deps.db) return base;
    const now = Date.now();
    if (now - cachedAt < FIRM_MAIL_TTL_MS) return cached ?? base;
    try {
      const [firm] = await deps.db.select({ id: firms.id }).from(firms).limit(1);
      cached = firm
        ? await loadFirmMailProvider(deps.db, firm.id, deps.log, {
            emailitStashAttachmentUrl: deps.emailitStashAttachmentUrl,
          })
        : null;
    } catch (err) {
      deps.log.warn({ err }, 'firm mail provider resolve failed; using env fallback');
      cached = null;
    }
    cachedAt = now;
    return cached ?? base;
  }
  return {
    id: base.id,
    async send(msg: MailMessage) {
      return (await resolve()).send(msg);
    },
  };
}
