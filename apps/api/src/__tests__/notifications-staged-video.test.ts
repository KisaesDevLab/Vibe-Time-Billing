// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clientContacts,
  engagementVideos,
  notificationTemplates,
  persons,
  stagedNotifications,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { stageVideoNotification } from '../notifications/staged/video';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

async function insertVideo(title = 'Return walkthrough'): Promise<string> {
  const [v] = await harness.db
    .insert(engagementVideos)
    .values({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      clientId: seed.clientId,
      title,
      message: 'Watch before our call.',
      originalFilename: 'walkthrough.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1000,
      storageKey: `system/engagement-videos/${seed.firmId}/x/${crypto.randomUUID()}/walkthrough.mp4`,
      status: 'AVAILABLE',
      uploadedBy: seed.appUserId,
    })
    .returning({ id: engagementVideos.id });
  return v!.id;
}

function stage(videoId: string) {
  return stageVideoNotification(harness.db, {
    firmId: seed.firmId,
    engagementId: seed.engagementId,
    clientId: seed.clientId,
    videoId,
    title: 'Return walkthrough',
    message: 'Watch before our call.',
    actorAppUserId: seed.appUserId,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    portalBaseUrl: 'https://portal.example.test/',
  });
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('stageVideoNotification', () => {
  it('stages an IMMEDIATE row on all three channels for every eligible contact', async () => {
    const a = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Lisa Vance',
      email: 'lisa@example.com',
      mobile: '+15555550100',
      isBilling: true,
    });
    const b = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Opted Out',
      email: 'out@example.com',
    });
    await harness.db
      .update(clientContacts)
      .set({ receiveStatusNotifications: false })
      .where(eq(clientContacts.id, b.contactId));
    const c = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'No Texts',
      email: 'notexts@example.com',
      phone: '+15555550199',
    });
    await harness.db.update(persons).set({ smsOptOut: true }).where(eq(persons.id, c.personId));

    const videoId = await insertVideo();
    const r = await stage(videoId);
    expect(r.stagedNotificationId).not.toBeNull();

    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, r.stagedNotificationId!));
    expect(row?.mode).toBe('IMMEDIATE');
    expect(row?.status).toBe('SCHEDULED');
    expect(row?.channels).toEqual(['EMAIL', 'SMS', 'PORTAL']);
    expect(row?.recipientMode).toBe('ALL_CONTACTS');
    expect(row?.entityType).toBe('engagement_video');
    expect(row?.entityId).toBe(videoId);
    expect(row?.templateKind).toBe('engagement_video_ready');
    expect(row?.supersedeKey).toBe(`engagement_video:${videoId}`);

    const recipients = row?.recipients as Array<{
      personId: string;
      phone: string | null;
      smsOptOut?: boolean;
    }>;
    expect(recipients.map((x) => x.personId).sort()).toEqual([a.personId, c.personId].sort());
    expect(recipients.find((x) => x.personId === a.personId)?.phone).toBe('+15555550100');
    expect(recipients.find((x) => x.personId === c.personId)?.smsOptOut).toBe(true);

    const rendered = row?.rendered as Record<string, { subject: string | null; body: string }>;
    expect(rendered['EMAIL']?.subject).toContain('new video');
    expect(rendered['EMAIL']?.body).toContain('Return walkthrough');
    expect(rendered['EMAIL']?.body).toContain(`https://portal.example.test/videos/${videoId}`);
    expect(rendered['SMS']?.body).toContain('Test Engagement');
    expect(rendered['PORTAL']?.subject).toBe('New video: Return walkthrough');
  });

  it('returns null and stages nothing when no contact is eligible', async () => {
    const videoId = await insertVideo();
    const r = await stage(videoId);
    expect(r.stagedNotificationId).toBeNull();
    const rows = await harness.db.select().from(stagedNotifications);
    expect(rows).toHaveLength(0);
  });

  it('uses the firm template override when enabled', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Lisa Vance',
      email: 'lisa@example.com',
    });
    await harness.db.insert(notificationTemplates).values({
      firmId: seed.firmId,
      kind: 'engagement_video_ready',
      channel: 'EMAIL',
      subject: 'Custom: {{ video.title }}',
      body: 'Custom body {{ link.url }}',
      enabled: true,
    });
    const videoId = await insertVideo();
    const r = await stage(videoId);
    const [row] = await harness.db
      .select({ rendered: stagedNotifications.rendered })
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, r.stagedNotificationId!));
    const rendered = row?.rendered as Record<string, { subject: string | null; body: string }>;
    expect(rendered['EMAIL']?.subject).toBe('Custom: Return walkthrough');
    expect(rendered['EMAIL']?.body).toBe(
      `Custom body https://portal.example.test/videos/${videoId}`,
    );
  });

  it('two videos stage two rows (distinct supersede keys)', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Lisa Vance',
      email: 'lisa@example.com',
    });
    const v1 = await insertVideo('One');
    const v2 = await insertVideo('Two');
    await stage(v1);
    await stage(v2);
    const rows = await harness.db.select().from(stagedNotifications);
    expect(rows.map((r) => r.status)).toEqual(['SCHEDULED', 'SCHEDULED']);
  });
});
