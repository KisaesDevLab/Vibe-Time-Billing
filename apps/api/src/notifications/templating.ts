// SPDX-License-Identifier: Elastic-2.0
//
// DB-aware notification templating for the API realm. Wraps the pure
// renderer in @vibe/core/notifications with a loader for the firm's
// `notification_template` override and a firm-branding merge scope (name,
// logo URL, support details) shared by every outbound email/SMS.
//
// Pattern for a send site:
//   const firm = await firmScope(db, firmId);
//   const { subject, body } = await renderTemplate({
//     db, firmId, kind: 'intake_link', channel: 'EMAIL',
//     fallback: { subject: '…', body: '…' },
//     context: { client: { name }, firm, link: { url } },
//   });
//
// The override is used only when present + enabled + non-empty, so an
// admin who hasn't touched the template still gets the seeded/fallback
// copy. Tokens missing from the context resolve to empty string.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings, firms, notificationTemplates } from '@vibe/db/schema';
import {
  buildFirmScope,
  renderNotification,
  type NotificationTemplate,
  type RenderedNotification,
} from '@vibe/core/notifications';
import type { MergeContext } from '@vibe/core/proposals';

export type TemplateChannel = 'EMAIL' | 'SMS' | 'CALL' | 'PORTAL' | 'PRINT';

/** Firm's enabled template override for (kind, channel), or null. */
export async function loadNotificationTemplate(
  db: Database,
  firmId: string,
  kind: string,
  channel: TemplateChannel,
): Promise<NotificationTemplate | null> {
  const [row] = await db
    .select({
      subject: notificationTemplates.subject,
      body: notificationTemplates.body,
      enabled: notificationTemplates.enabled,
    })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.firmId, firmId),
        eq(notificationTemplates.kind, kind),
        eq(notificationTemplates.channel, channel),
      ),
    )
    .limit(1);
  if (row && row.enabled && row.body) return { subject: row.subject, body: row.body };
  return null;
}

/** Load + render a notification, falling back to the supplied default copy. */
export async function renderTemplate(args: {
  db: Database | null;
  firmId: string;
  kind: string;
  channel: TemplateChannel;
  fallback: NotificationTemplate;
  context: MergeContext;
}): Promise<RenderedNotification> {
  let override: NotificationTemplate | null = null;
  if (args.db) {
    override = await loadNotificationTemplate(args.db, args.firmId, args.kind, args.channel);
  }
  return renderNotification({ override, fallback: args.fallback, context: args.context });
}

/**
 * Build the `firm.*` merge scope for a firm from firm_settings branding +
 * the firm's legal name. Use the result under the `firm` key of a
 * MergeContext. Returns name-only if settings are missing.
 */
export async function firmScope(
  db: Database | null,
  firmId: string,
): Promise<Record<string, string>> {
  if (!db) return buildFirmScope({});
  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, firmId))
    .limit(1);
  const [s] = await db
    .select({
      displayName: firmSettings.brandDisplayName,
      logoUrl: firmSettings.brandLogoUrl,
      accentColor: firmSettings.brandAccentColor,
      supportEmail: firmSettings.brandSupportEmail,
      supportPhone: firmSettings.brandSupportPhone,
      supportFax: firmSettings.brandSupportFax,
      supportWeb: firmSettings.brandSupportWeb,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  return buildFirmScope({ name: firm?.name ?? null, ...s });
}
