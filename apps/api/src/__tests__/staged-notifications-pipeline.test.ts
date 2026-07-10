// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0146 — staging pipeline for client notifications. Verifies: a STAGED
// status transition snapshots a PENDING_APPROVAL row (recipients +
// rendered per-channel content), IMMEDIATE goes straight to SCHEDULED,
// a newer transition supersedes the unsent row, firm templates win over
// defaults, billing-contact resolution falls back to all contacts, and
// the admin status endpoints round-trip the new notify fields.
// NODE_ENV=test disables the BullMQ producer (no Redis in tests).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';

import {
  clientContacts,
  engagementStatusConfig,
  notificationTemplates,
  stagedNotifications,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  seedContact,
  type PgliteHarness,
} from './_pglite-harness';
import { stageStatusNotification } from '../notifications/staged/pipeline';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

async function configureStatus(opts: {
  workflowState: string;
  notifyMode?: 'IMMEDIATE' | 'STAGED';
  notifyChannels?: string[];
  notifyRecipients?: 'BILLING_CONTACT' | 'ALL_CONTACTS';
  triggersClientComm?: boolean;
  clientLabel?: string | null;
}): Promise<void> {
  await harness.db.insert(engagementStatusConfig).values({
    firmId: seed.firmId,
    workflowState: opts.workflowState,
    label: opts.workflowState.replace(/_/g, ' ').toLowerCase(),
    triggersClientComm: opts.triggersClientComm ?? true,
    notifyMode: opts.notifyMode ?? 'STAGED',
    notifyChannels: opts.notifyChannels ?? ['EMAIL'],
    notifyRecipients: opts.notifyRecipients ?? 'BILLING_CONTACT',
    clientLabel: opts.clientLabel ?? null,
  });
}

function stage(toState: string, fromState: string | null = 'IN_PROGRESS') {
  return stageStatusNotification(harness.db, {
    firmId: seed.firmId,
    engagementId: seed.engagementId,
    clientId: seed.clientId,
    fromState,
    toState,
    actorAppUserId: seed.appUserId,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  });
}

describe('stageStatusNotification', () => {
  it('stages a PENDING_APPROVAL row with recipient + rendered snapshots', async () => {
    await configureStatus({
      workflowState: 'WITH_CLIENT',
      notifyChannels: ['EMAIL', 'SMS'],
      clientLabel: 'Waiting on you',
    });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Lisa Vance',
      email: 'lisa@example.com',
      phone: '+15555550100',
      isBilling: true,
    });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Other Person',
      email: 'other@example.com',
    });

    const { stagedNotificationId } = await stage('WITH_CLIENT');
    expect(stagedNotificationId).toBeTruthy();

    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, stagedNotificationId!));
    expect(row!.status).toBe('PENDING_APPROVAL');
    expect(row!.mode).toBe('STAGED');
    expect(row!.channels).toEqual(['EMAIL', 'SMS']);
    expect(row!.supersedeKey).toBe(`engagement_status:${seed.engagementId}`);
    expect(row!.templateKind).toBe('engagement_status:WITH_CLIENT');
    expect(row!.scheduledAt).toBeNull();

    // Billing contact only (one of the two seeded contacts).
    const recipients = row!.recipients as Array<{ name: string; email: string }>;
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.email).toBe('lisa@example.com');

    // Default template rendered with client-facing label.
    const rendered = row!.rendered as Record<string, { subject: string | null; body: string }>;
    expect(rendered['EMAIL']!.subject).toBe('Update on Test Engagement');
    expect(rendered['EMAIL']!.body).toContain('"Waiting on you"');
    expect(rendered['SMS']!.body).toContain('Test Client Co');
  });

  it('IMMEDIATE mode lands as SCHEDULED with scheduled_at set', async () => {
    await configureStatus({ workflowState: 'COMPLETED_X', notifyMode: 'IMMEDIATE' });
    const { stagedNotificationId } = await stage('COMPLETED_X');
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, stagedNotificationId!));
    expect(row!.status).toBe('SCHEDULED');
    expect(row!.scheduledAt).not.toBeNull();
  });

  it('a newer transition supersedes the unsent row', async () => {
    await configureStatus({ workflowState: 'STATE_A' });
    await configureStatus({ workflowState: 'STATE_B' });

    const first = await stage('STATE_A');
    const second = await stage('STATE_B', 'STATE_A');

    const [a] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, first.stagedNotificationId!));
    expect(a!.status).toBe('CANCELED');
    expect(a!.canceledReason).toBe('SUPERSEDED');

    const [b] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, second.stagedNotificationId!));
    expect(b!.status).toBe('PENDING_APPROVAL');
  });

  it('does not stage when comm is disabled, channels are empty, or state unchanged', async () => {
    await configureStatus({ workflowState: 'QUIET', triggersClientComm: false });
    expect((await stage('QUIET')).stagedNotificationId).toBeNull();

    await configureStatus({ workflowState: 'NO_CHANNELS', notifyChannels: [] });
    expect((await stage('NO_CHANNELS')).stagedNotificationId).toBeNull();

    await configureStatus({ workflowState: 'SAME' });
    expect((await stage('SAME', 'SAME')).stagedNotificationId).toBeNull();
  });

  it('uses an enabled firm template over the default', async () => {
    await configureStatus({ workflowState: 'CUSTOM_TPL' });
    await harness.db.insert(notificationTemplates).values({
      firmId: seed.firmId,
      kind: 'engagement_status:CUSTOM_TPL',
      channel: 'EMAIL',
      subject: 'Custom for {{client.name}}',
      body: 'Body {{engagement.name}}',
      enabled: true,
    });
    const { stagedNotificationId } = await stage('CUSTOM_TPL');
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, stagedNotificationId!));
    const rendered = row!.rendered as Record<string, { subject: string | null; body: string }>;
    expect(rendered['EMAIL']!.subject).toBe('Custom for Test Client Co');
    expect(rendered['EMAIL']!.body).toBe('Body Test Engagement');
  });

  it('0166 — excludes a contact opted out of status notifications', async () => {
    await configureStatus({ workflowState: 'OPTOUT', notifyRecipients: 'ALL_CONTACTS' });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Opted In',
      email: 'in@example.com',
    });
    const { contactId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Opted Out',
      email: 'out@example.com',
    });
    await harness.db
      .update(clientContacts)
      .set({ receiveStatusNotifications: false })
      .where(eq(clientContacts.id, contactId));

    const { stagedNotificationId } = await stage('OPTOUT');
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, stagedNotificationId!));
    const recipients = row!.recipients as Array<{ email: string | null }>;
    expect(recipients.map((r) => r.email)).toEqual(['in@example.com']);
  });

  it('0166 — forceStaged queues PENDING_APPROVAL even for an IMMEDIATE status', async () => {
    await configureStatus({ workflowState: 'IMM_FORCE', notifyMode: 'IMMEDIATE' });
    const { stagedNotificationId } = await stageStatusNotification(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      clientId: seed.clientId,
      fromState: null,
      toState: 'IMM_FORCE',
      actorAppUserId: seed.appUserId,
      ip: '127.0.0.1',
      userAgent: 'vitest',
      forceStaged: true,
    });
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, stagedNotificationId!));
    expect(row!.status).toBe('PENDING_APPROVAL');
    expect(row!.scheduledAt).toBeNull();
  });

  it('falls back to all contacts when no billing contact exists', async () => {
    await configureStatus({ workflowState: 'FALLBACK' });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Plain Contact',
      email: 'plain@example.com',
    });
    const { stagedNotificationId } = await stage('FALLBACK');
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, stagedNotificationId!));
    const recipients = row!.recipients as Array<{ email: string | null }>;
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.email).toBe('plain@example.com');
  });
});

describe('admin notify fields', () => {
  it('round-trips notifyMode/notifyChannels/notifyRecipients through the config row', async () => {
    await configureStatus({
      workflowState: 'ROUNDTRIP',
      notifyMode: 'IMMEDIATE',
      notifyChannels: ['EMAIL', 'SMS', 'PORTAL'],
      notifyRecipients: 'ALL_CONTACTS',
    });
    const [row] = await harness.db
      .select()
      .from(engagementStatusConfig)
      .where(
        and(
          eq(engagementStatusConfig.firmId, seed.firmId),
          eq(engagementStatusConfig.workflowState, 'ROUNDTRIP'),
        ),
      );
    expect(row!.notifyMode).toBe('IMMEDIATE');
    expect(row!.notifyChannels).toEqual(['EMAIL', 'SMS', 'PORTAL']);
    expect(row!.notifyRecipients).toBe('ALL_CONTACTS');
  });
});
