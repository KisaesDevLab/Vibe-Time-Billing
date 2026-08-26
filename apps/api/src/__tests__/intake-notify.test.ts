// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Intake arrival notification. The worker can't name the submitter (it
// holds no firm key), so it hands the job here; these tests lock in that
// the composed email/SMS carries the name + contact details off the
// intake form, and that a locked appliance still gets a notification out
// with the generic copy instead of failing or leaking a decrypt error.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { intakeSessions, intakeStaffCards } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { newIntakeRecordKey, encField } from '../intake/crypto';
import {
  composeIntakeNotification,
  processIntakeNotifyJob,
  type IntakeNotifyDeps,
} from '../intake/notify-queue';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-intake-notify-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await getFirmKeyManager(harness.db).bootstrap({
    firmId: seed.firmId,
    mode: 'sealed-on-disk',
  });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  await harness.db.insert(intakeStaffCards).values({
    firmId: seed.firmId,
    userId: seed.appUserId,
    isVisible: true,
    acceptingUploads: true,
    notifyEmail: true,
    notifySms: true,
  });
  // seedMinimalFirm's user has no phone; give it one so SMS is exercised.
  await harness.db.execute(
    sql`UPDATE app_user SET mobile_phone = '+15550001111' WHERE id = ${seed.appUserId}`,
  );
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

async function seedSession(fields: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  message?: string | null;
}): Promise<string> {
  const { dek, wrappedDek } = newIntakeRecordKey(harness.db, seed.firmId);
  const [s] = await harness.db
    .insert(intakeSessions)
    .values({
      firmId: seed.firmId,
      targetStaffId: seed.appUserId,
      wrappedDek: Buffer.from(wrappedDek),
      clientNameEnc: encField(dek, fields.name ?? null),
      clientEmailEnc: encField(dek, fields.email ?? null),
      clientPhoneEnc: encField(dek, fields.phone ?? null),
      messageEnc: encField(dek, fields.message ?? null),
      hasMessage: Boolean(fields.message),
      status: 'received',
    })
    .returning({ id: intakeSessions.id });
  return s!.id;
}

function collectingDeps(): IntakeNotifyDeps & {
  emails: Array<{ to: string; subject: string; body: string }>;
  texts: Array<{ to: string; body: string }>;
} {
  const emails: Array<{ to: string; subject: string; body: string }> = [];
  const texts: Array<{ to: string; body: string }> = [];
  return {
    db: harness.db,
    appBaseUrl: 'https://app.test',
    emails,
    texts,
    sendEmail: async (a) => {
      emails.push(a);
    },
    sendSms: async (a) => {
      texts.push(a);
    },
  };
}

describe('intake arrival notification', () => {
  it('names the submitter and includes their contact details', async () => {
    const sessionId = await seedSession({
      name: 'Dana Ruiz',
      email: 'dana@example.com',
      phone: '(555) 867-5309',
      message: 'Here are my 2025 W-2s. Call me before you file.',
    });
    const deps = collectingDeps();

    const outcome = await processIntakeNotifyJob(deps, {
      sessionId,
      firmId: seed.firmId,
      fileCount: 2,
    });

    expect(outcome).toBe('sent');
    expect(deps.emails).toHaveLength(1);
    const mail = deps.emails[0]!;
    expect(mail.subject).toBe('New document submission from Dana Ruiz');
    expect(mail.body).toContain('Dana Ruiz sent you 2 files and a message');
    expect(mail.body).toContain('dana@example.com');
    expect(mail.body).toContain('(555) 867-5309');
    expect(mail.body).toContain('Call me before you file.');
    expect(mail.body).toContain('https://app.test/intake');

    // The text names the sender and one way to reach them, nothing more.
    expect(deps.texts).toHaveLength(1);
    expect(deps.texts[0]!.body).toBe(
      'New intake submission from Dana Ruiz ((555) 867-5309) in your Intake inbox.',
    );
    expect(deps.texts[0]!.body).not.toContain('W-2s');
  });

  it('omits the lines it has no value for', async () => {
    const sessionId = await seedSession({ name: 'Sam Okafor' });
    const deps = collectingDeps();

    await processIntakeNotifyJob(deps, { sessionId, firmId: seed.firmId, fileCount: 1 });

    const body = deps.emails[0]!.body;
    expect(body).toContain('Name:  Sam Okafor');
    expect(body).not.toContain('Email:');
    expect(body).not.toContain('Phone:');
    expect(body).not.toContain('Message:');
    expect(body).toContain('Sam Okafor sent you 1 file');
  });

  it('still notifies with generic copy when the appliance is locked', async () => {
    const sessionId = await seedSession({ name: 'Dana Ruiz', email: 'dana@example.com' });
    setApplianceLockState({ kind: 'locked', firmId: seed.firmId, reason: 'awaiting-passphrase' });
    const deps = collectingDeps();

    const outcome = await processIntakeNotifyJob(deps, {
      sessionId,
      firmId: seed.firmId,
      fileCount: 1,
    });

    expect(outcome).toBe('sent');
    const mail = deps.emails[0]!;
    expect(mail.subject).toBe('New document submission received');
    expect(mail.body).not.toContain('Dana Ruiz');
    expect(mail.body).not.toContain('dana@example.com');
    expect(deps.texts[0]!.body).toBe('New document submission in your Intake inbox.');
  });

  it('honors the staff card notify preferences', async () => {
    const sessionId = await seedSession({ name: 'Dana Ruiz' });
    await harness.db
      .update(intakeStaffCards)
      .set({ notifySms: false })
      .where(eq(intakeStaffCards.userId, seed.appUserId));
    const deps = collectingDeps();

    await processIntakeNotifyJob(deps, { sessionId, firmId: seed.firmId, fileCount: 1 });

    expect(deps.emails).toHaveLength(1);
    expect(deps.texts).toHaveLength(0);
  });

  it('skips a session whose target staff has no intake card', async () => {
    const sessionId = await seedSession({ name: 'Dana Ruiz' });
    await harness.db.delete(intakeStaffCards).where(eq(intakeStaffCards.userId, seed.appUserId));
    const deps = collectingDeps();

    const outcome = await processIntakeNotifyJob(deps, {
      sessionId,
      firmId: seed.firmId,
      fileCount: 1,
    });

    expect(outcome).toBe('skipped');
    expect(deps.emails).toHaveLength(0);
  });
});

describe('composeIntakeNotification', () => {
  it('describes a message-only submission as a message', () => {
    const { body } = composeIntakeNotification({
      fileCount: 0,
      inboxUrl: null,
      details: { name: 'Dana Ruiz', email: null, phone: null, message: 'Quick question' },
    });
    expect(body).toContain('Dana Ruiz sent you a message');
  });

  it('trims a long message to a preview', () => {
    const { body } = composeIntakeNotification({
      fileCount: 1,
      inboxUrl: null,
      details: { name: 'Dana Ruiz', email: null, phone: null, message: 'x'.repeat(500) },
    });
    expect(body).toContain(`${'x'.repeat(300)}…`);
    expect(body).not.toContain('x'.repeat(301));
  });
});
