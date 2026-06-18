// SPDX-License-Identifier: Elastic-2.0
//
// Worker-realm mirror of apps/api/src/notifications/templating.ts — loads a
// firm's `notification_template` override and builds the shared firm-branding
// merge scope so worker-dispatched notifications (dunning, retainer expiry,
// drop-off reminders, …) honour the same firm-editable templates as the API.

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

export type TemplateChannel = 'EMAIL' | 'SMS' | 'CALL' | 'PORTAL';

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
