// SPDX-License-Identifier: Elastic-2.0
//
// Mail wrapper that gives every outbound email a branded HTML body (firm logo
// + name header, support footer) when the caller didn't supply its own HTML.
// Branding is loaded from firm_settings and cached briefly so high-volume sends
// don't hit the DB per message. Single-firm appliance → first firm.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings, firms } from '@vibe/db/schema';
import { wrapPlainTextEmail, type EmailBranding } from '@vibe/core/notifications';

import type { MailProvider } from '../mail/provider';

const TTL_MS = 60_000;

export function loadEmailBranding(db: Database | null): () => Promise<EmailBranding> {
  let cache: EmailBranding | null = null;
  let cachedAt = 0;
  return async () => {
    const now = Date.now();
    if (cache && now - cachedAt < TTL_MS) return cache;
    if (!db) {
      cache = {};
      cachedAt = now;
      return cache;
    }
    try {
      const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
      if (!firm) {
        cache = {};
        cachedAt = now;
        return cache;
      }
      const [s] = await db
        .select({
          firmName: firmSettings.brandDisplayName,
          logoUrl: firmSettings.brandLogoUrl,
          accentColor: firmSettings.brandAccentColor,
          supportEmail: firmSettings.brandSupportEmail,
          supportPhone: firmSettings.brandSupportPhone,
        })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firm.id))
        .limit(1);
      cache = s ?? {};
      cachedAt = now;
      return cache;
    } catch {
      return cache ?? {};
    }
  };
}

export function wrapMailWithBranding(
  inner: MailProvider,
  deps: { db: Database | null },
): MailProvider {
  const branding = loadEmailBranding(deps.db);
  return {
    id: inner.id,
    async send(msg) {
      if (msg.html) return inner.send(msg);
      const html = wrapPlainTextEmail({ text: msg.body, branding: await branding() });
      return inner.send({ ...msg, html });
    },
  };
}
