// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0235 — "a new video is ready" client notification. Rides the staged
// notification pipeline (EMAIL + SMS + PORTAL → the worker fans out,
// writes the client_communication timeline, honours live SMS opt-out and
// mirrors PORTAL rows to Web Push). Always IMMEDIATE — staff chose to
// notify when they uploaded — and always ALL_CONTACTS (D4).

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements, stagedNotifications } from '@vibe/db/schema';

import { emitAudit } from '../../auth/audit';
import { logger } from '../../logger';
import { firmScope, renderTemplate } from '../templating';
import { loadEligibleContactRecipients, toRecipientSnapshot } from './pipeline';
import { enqueueStagedSend } from './queue';

export const VIDEO_READY_TEMPLATE_KIND = 'engagement_video_ready';

export function videoSupersedeKey(videoId: string): string {
  return `engagement_video:${videoId}`;
}

/** Portal path the notification deep-links to (relative; the worker and
 *  the email template both prefix it). */
export function videoPortalPath(videoId: string): string {
  return `/videos/${videoId}`;
}

export interface StageVideoNotificationArgs {
  firmId: string;
  engagementId: string;
  clientId: string;
  videoId: string;
  title: string;
  message: string | null;
  actorAppUserId: string;
  ip: string | null;
  userAgent: string | null;
  /** PORTAL_BASE_URL (no trailing slash) for {{ link.url }}. */
  portalBaseUrl: string;
}

const FALLBACK = {
  EMAIL: {
    subject: 'A new video from {{ firm.displayName }} is ready to watch',
    body:
      'Dear {{ client.name }},\n\n' +
      '{{ firm.displayName }} has shared a video with you for {{ engagement.name }}: "{{ video.title }}".\n\n' +
      '{{ video.message }}\n\n' +
      'Watch it securely in your client portal:\n{{ link.url }}\n\n' +
      'Questions? Contact us at {{ firm.support_email }}.\n\n' +
      '{{ firm.displayName }}',
  },
  SMS: {
    subject: null,
    body: '{{ firm.displayName }}: a new video is ready for you to watch ({{ engagement.name }}). {{ link.url }}',
  },
  PORTAL: {
    subject: 'New video: {{ video.title }}',
    body: '{{ firm.displayName }} shared a video for {{ engagement.name }}. Tap to watch.',
  },
} as const;

export async function stageVideoNotification(
  db: Database,
  args: StageVideoNotificationArgs,
): Promise<{ stagedNotificationId: string | null }> {
  const [row] = await db
    .select({ engagementName: engagements.name, clientName: clients.name })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(eq(engagements.id, args.engagementId))
    .limit(1);
  if (!row) return { stagedNotificationId: null };

  const recipients = (await loadEligibleContactRecipients(db, args.clientId)).map(
    toRecipientSnapshot,
  );
  if (recipients.length === 0) {
    logger.info({ videoId: args.videoId }, 'video notification skipped: no eligible contacts');
    return { stagedNotificationId: null };
  }

  const firm = await firmScope(db, args.firmId);
  const context = {
    client: { name: row.clientName },
    firm,
    engagement: { name: row.engagementName },
    video: { title: args.title, message: args.message ?? '' },
    link: { url: `${args.portalBaseUrl.replace(/\/$/, '')}${videoPortalPath(args.videoId)}` },
    today: new Date().toISOString().slice(0, 10),
  };
  const channels = ['EMAIL', 'SMS', 'PORTAL'] as const;
  const rendered: Record<string, { subject: string | null; body: string }> = {};
  for (const channel of channels) {
    rendered[channel] = await renderTemplate({
      db,
      firmId: args.firmId,
      kind: VIDEO_READY_TEMPLATE_KIND,
      channel,
      fallback: FALLBACK[channel],
      context,
    });
  }

  const now = new Date();
  let newId = '';
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(stagedNotifications)
      .values({
        firmId: args.firmId,
        clientId: args.clientId,
        triggerKind: 'engagement_video',
        entityType: 'engagement_video',
        entityId: args.videoId,
        triggerContext: { engagementId: args.engagementId, videoTitle: args.title },
        supersedeKey: videoSupersedeKey(args.videoId),
        mode: 'IMMEDIATE',
        status: 'SCHEDULED',
        channels: [...channels],
        recipientMode: 'ALL_CONTACTS',
        recipients,
        rendered,
        templateKind: VIDEO_READY_TEMPLATE_KIND,
        scheduledAt: now,
        createdBy: args.actorAppUserId,
      })
      .returning({ id: stagedNotifications.id });
    newId = inserted!.id;
    await emitAudit(
      // reason: tx shares the Database query surface; emitAudit only inserts.
      tx as unknown as Database,
      {
        action: 'CREATE',
        entityType: 'staged_notification',
        entityId: newId,
        actorAppUserId: args.actorAppUserId,
        before: null,
        after: {
          status: 'SCHEDULED',
          triggerKind: 'engagement_video',
          videoId: args.videoId,
          engagementId: args.engagementId,
          channels: [...channels],
          recipientCount: recipients.length,
        },
        ip: args.ip,
        userAgent: args.userAgent,
      },
    );
  });

  // Queue after commit so a rollback can't strand a job.
  await enqueueStagedSend(newId);
  logger.info({ stagedNotificationId: newId, videoId: args.videoId }, 'video notification staged');
  return { stagedNotificationId: newId };
}
