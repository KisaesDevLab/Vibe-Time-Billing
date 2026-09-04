// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0146 — staged-notification send job. Verifies: a SCHEDULED row fans
// out EMAIL/SMS via the dispatchers and lands SENT with
// client_communication + notification_log rows; PORTAL inserts one
// portal_notification per ACTIVE portal identity; the fire-time guard
// cancels when the engagement moved on; all-channels-failed lands
// FAILED; non-SCHEDULED rows are skipped untouched.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  type PgliteHarness,
} from '../../../api/src/__tests__/_pglite-harness';
import {
  clientCommunications,
  clientPortalAccess,
  engagementVideos,
  engagements,
  notificationLog,
  portalIdentity,
  portalNotifications,
  stagedNotifications,
} from '@vibe/db/schema';

import { runStagedNotificationSend } from '../jobs/staged-notification-send';

const silent = pino({ enabled: false });
let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

async function insertRow(opts: {
  status?: 'PENDING_APPROVAL' | 'SCHEDULED' | 'SENT' | 'CANCELED' | 'FAILED';
  channels?: string[];
  workflowState?: string;
  /** 0235 — override the trigger to stage an engagement-video notice. */
  video?: { id: string };
  recipients?: Array<{
    personId: string;
    name: string;
    email: string | null;
    phone: string | null;
  }>;
}): Promise<string> {
  const [row] = await harness.db
    .insert(stagedNotifications)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      triggerKind: opts.video ? 'engagement_video' : 'engagement_status',
      entityType: opts.video ? 'engagement_video' : 'engagement',
      entityId: opts.video ? opts.video.id : seed.engagementId,
      triggerContext: opts.video
        ? { engagementId: seed.engagementId, videoTitle: 'Walkthrough' }
        : {
            workflowState: opts.workflowState ?? 'WITH_CLIENT',
            fromState: 'IN_PROGRESS',
            statusLabel: 'With client',
          },
      supersedeKey: opts.video
        ? `engagement_video:${opts.video.id}`
        : `engagement_status:${seed.engagementId}`,
      mode: 'STAGED',
      status: opts.status ?? 'SCHEDULED',
      channels: opts.channels ?? ['EMAIL'],
      recipientMode: 'BILLING_CONTACT',
      recipients: opts.recipients ?? [
        { personId: 'p1', name: 'Lisa', email: 'lisa@example.com', phone: '+15555550100' },
      ],
      rendered: {
        EMAIL: { subject: 'Update on Test Engagement', body: 'Email body' },
        SMS: { subject: null, body: 'Sms body' },
        PORTAL: { subject: 'Portal title', body: 'Portal body' },
      },
      templateKind: 'engagement_status:WITH_CLIENT',
      scheduledAt: new Date(),
    })
    .returning({ id: stagedNotifications.id });
  return row!.id;
}

async function setEngagementState(ws: string): Promise<void> {
  await harness.db
    .update(engagements)
    .set({ workflowState: ws })
    .where(eq(engagements.id, seed.engagementId));
}

describe('runStagedNotificationSend', () => {
  it('sends EMAIL + SMS, logs timeline + send audit, lands SENT', async () => {
    await setEngagementState('WITH_CLIENT');
    const id = await insertRow({ channels: ['EMAIL', 'SMS'] });
    const emails: string[] = [];
    const texts: string[] = [];
    const r = await runStagedNotificationSend(
      harness.db,
      silent,
      {
        sendEmail: async (a) => {
          emails.push(a.to);
        },
        sendSms: async (a) => {
          texts.push(a.to);
        },
      },
      { stagedNotificationId: id },
    );
    expect(r.outcome).toBe('sent');
    expect(emails).toEqual(['lisa@example.com']);
    expect(texts).toEqual(['+15555550100']);

    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('SENT');
    expect(row!.sentAt).not.toBeNull();
    const results = row!.channelResults as Record<string, { ok: boolean }>;
    expect(results['EMAIL']!.ok).toBe(true);
    expect(results['SMS']!.ok).toBe(true);

    const comms = await harness.db
      .select()
      .from(clientCommunications)
      .where(eq(clientCommunications.clientId, seed.clientId));
    expect(comms.map((c) => c.channel).sort()).toEqual(['EMAIL', 'SMS']);
    expect(comms.every((c) => c.direction === 'OUTBOUND')).toBe(true);

    const sendLog = await harness.db.select().from(notificationLog);
    expect(sendLog).toHaveLength(2);
    expect(sendLog.every((l) => l.status === 'sent')).toBe(true);
  });

  it('PORTAL inserts one portal_notification per ACTIVE identity', async () => {
    await setEngagementState('WITH_CLIENT');
    const [ident] = await harness.db
      .insert(portalIdentity)
      .values({ firmId: seed.firmId, fullName: 'Lisa Vance', primaryEmail: 'lisa@example.com' })
      .returning({ id: portalIdentity.id });
    await harness.db.insert(clientPortalAccess).values({
      portalIdentityId: ident!.id,
      clientId: seed.clientId,
      role: 'FULL',
      status: 'ACTIVE',
    });
    const id = await insertRow({ channels: ['PORTAL'] });
    const r = await runStagedNotificationSend(harness.db, silent, {}, { stagedNotificationId: id });
    expect(r.outcome).toBe('sent');

    const notes = await harness.db
      .select()
      .from(portalNotifications)
      .where(eq(portalNotifications.portalIdentityId, ident!.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Portal title');
    expect(notes[0]!.status).toBe('UNREAD');
    expect(notes[0]!.actionUrl).toBe('/engagements');
  });

  it('cancels at fire time when the engagement moved on', async () => {
    await setEngagementState('COMPLETED');
    const id = await insertRow({ workflowState: 'WITH_CLIENT' });
    const r = await runStagedNotificationSend(
      harness.db,
      silent,
      { sendEmail: async () => undefined },
      { stagedNotificationId: id },
    );
    expect(r.outcome).toBe('canceled_at_fire');
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('CANCELED');
    expect(row!.canceledReason).toBe('STATE_CHANGED_AT_FIRE');
    const comms = await harness.db.select().from(clientCommunications);
    expect(comms).toHaveLength(0);
  });

  it('lands FAILED when every channel fails', async () => {
    await setEngagementState('WITH_CLIENT');
    // PORTAL has no identities; EMAIL recipient has no address.
    const id = await insertRow({
      channels: ['EMAIL', 'PORTAL'],
      recipients: [{ personId: 'p1', name: 'NoEmail', email: null, phone: null }],
    });
    const r = await runStagedNotificationSend(
      harness.db,
      silent,
      { sendEmail: async () => undefined },
      { stagedNotificationId: id },
    );
    expect(r.outcome).toBe('failed');
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('FAILED');
    expect(row!.errorMessage).toContain('no_recipient_handle');
    expect(row!.errorMessage).toContain('no_portal_access');
  });

  it('claims atomically — no duplicate send on re-invocation or for an in-flight (SENDING) row', async () => {
    await setEngagementState('WITH_CLIENT');
    const emails: string[] = [];
    const deps = {
      sendEmail: async (a: { to: string }) => {
        emails.push(a.to);
      },
    };

    // First delivery sends once and lands SENT.
    const id = await insertRow({ channels: ['EMAIL'] });
    const first = await runStagedNotificationSend(harness.db, silent, deps, {
      stagedNotificationId: id,
    });
    expect(first.outcome).toBe('sent');

    // A BullMQ stalled-job reprocess after completion (row now SENT) must NOT
    // re-send to the recipient.
    const second = await runStagedNotificationSend(harness.db, silent, deps, {
      stagedNotificationId: id,
    });
    expect(second.outcome).toBe('skipped');
    expect(emails).toEqual(['lisa@example.com']); // exactly once

    // A row left mid-flight in SENDING (worker crashed after the claim) is not
    // re-sent either — the claim's SCHEDULED-only guard rejects it.
    const id2 = await insertRow({ channels: ['EMAIL'] });
    await harness.db
      .update(stagedNotifications)
      .set({ status: 'SENDING' })
      .where(eq(stagedNotifications.id, id2));
    const third = await runStagedNotificationSend(harness.db, silent, deps, {
      stagedNotificationId: id2,
    });
    expect(third.outcome).toBe('skipped');
    expect(emails).toEqual(['lisa@example.com']); // still exactly once
  });

  it('skips rows that are not SCHEDULED', async () => {
    await setEngagementState('WITH_CLIENT');
    const id = await insertRow({ status: 'CANCELED' });
    const r = await runStagedNotificationSend(
      harness.db,
      silent,
      { sendEmail: async () => undefined },
      { stagedNotificationId: id },
    );
    expect(r.outcome).toBe('skipped');
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('CANCELED');
  });
  // 0235 — engagement video notices.
  async function insertVideo(status: 'AVAILABLE' | 'DELETED'): Promise<string> {
    const [v] = await harness.db
      .insert(engagementVideos)
      .values({
        firmId: seed.firmId,
        engagementId: seed.engagementId,
        clientId: seed.clientId,
        title: 'Walkthrough',
        originalFilename: 'w.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 10,
        storageKey: `system/engagement-videos/${seed.firmId}/${seed.engagementId}/${crypto.randomUUID()}/w.mp4`,
        status,
      })
      .returning({ id: engagementVideos.id });
    return v!.id;
  }

  it('video notice: portal notification deep-links to the player', async () => {
    const videoId = await insertVideo('AVAILABLE');
    const [ident] = await harness.db
      .insert(portalIdentity)
      .values({ firmId: seed.firmId, fullName: 'Lisa Vance', primaryEmail: 'lisa@example.com' })
      .returning({ id: portalIdentity.id });
    await harness.db.insert(clientPortalAccess).values({
      portalIdentityId: ident!.id,
      clientId: seed.clientId,
      role: 'FULL',
      status: 'ACTIVE',
    });
    const id = await insertRow({ channels: ['PORTAL'], video: { id: videoId } });
    const r = await runStagedNotificationSend(harness.db, silent, {}, { stagedNotificationId: id });
    expect(r.outcome).toBe('sent');
    const notes = await harness.db
      .select()
      .from(portalNotifications)
      .where(eq(portalNotifications.portalIdentityId, ident!.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.actionUrl).toBe(`/videos/${videoId}`);
    expect(notes[0]!.type).toBe('ENGAGEMENT_VIDEO');
  });

  it('video notice: cancels at fire time when the video is no longer available', async () => {
    const videoId = await insertVideo('DELETED');
    const id = await insertRow({ channels: ['EMAIL'], video: { id: videoId } });
    const emails: string[] = [];
    const r = await runStagedNotificationSend(
      harness.db,
      silent,
      {
        sendEmail: async (a) => {
          emails.push(a.to);
        },
      },
      { stagedNotificationId: id },
    );
    expect(r.outcome).toBe('canceled_at_fire');
    expect(emails).toHaveLength(0);
    const [row] = await harness.db
      .select({ status: stagedNotifications.status })
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row?.status).toBe('CANCELED');
  });
});
