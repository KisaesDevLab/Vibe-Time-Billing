// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0084 — runRequestReminderTick: emails the client billing contact
// when an OPEN / NEEDS_INFO request is within reminder_days_before
// of its due_date. Idempotent within a day via last_reminder_sent_at.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { pino } from 'pino';
import { eq, sql } from 'drizzle-orm';

import { clientRequests, persons } from '@vibe/db/schema';
import { runRequestReminderTick } from '../../../worker/src/jobs/request-reminder';
import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';

let harness: PgliteHarness;
const silentLog = pino({ level: 'silent' });

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seedContext(): Promise<{
  firmId: string;
  clientId: string;
  engagementId: string;
  appUserId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // Billing contact w/ email so the dispatcher has a target.
  await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Billing User',
    email: 'bill@example.com',
    isPrimary: true,
    isBilling: true,
  });
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    engagementId: seed.engagementId,
    appUserId: seed.appUserId,
  };
}

async function insertRequest(args: {
  firmId: string;
  engagementId: string;
  status?: string;
  kind?: string;
  dueDate: string | null;
  reminderDaysBefore: number | null;
  lastReminderSentAt?: string | null;
}): Promise<string> {
  const r = await harness.db.execute(
    sql`INSERT INTO client_request
          (firm_id, engagement_id, title, status, kind, due_date,
           reminder_days_before, last_reminder_sent_at)
        VALUES (${args.firmId}, ${args.engagementId}, 'Send W-2',
                ${args.status ?? 'OPEN'}, ${args.kind ?? 'GENERAL'}, ${args.dueDate},
                ${args.reminderDaysBefore}, ${args.lastReminderSentAt ?? null})
        RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('runRequestReminderTick', () => {
  it('emails an OPEN request within the reminder window and stamps last_reminder_sent_at', async () => {
    const ctx = await seedContext();
    const id = await insertRequest({
      firmId: ctx.firmId,
      engagementId: ctx.engagementId,
      dueDate: '2026-06-03',
      reminderDaysBefore: 3,
    });
    const sent: Array<{ to: string; subject: string; body: string }> = [];
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async (msg) => {
          sent.push({ to: msg.to, subject: msg.subject, body: msg.body });
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.scanned).toBe(1);
    expect(r.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('bill@example.com');
    expect(sent[0]!.subject).toContain('Send W-2');
    const [row] = await harness.db.select().from(clientRequests).where(eq(clientRequests.id, id));
    expect(row!.lastReminderSentAt).not.toBeNull();
  });

  it('also fires for NEEDS_INFO status', async () => {
    const ctx = await seedContext();
    await insertRequest({
      firmId: ctx.firmId,
      engagementId: ctx.engagementId,
      status: 'NEEDS_INFO',
      dueDate: '2026-06-02',
      reminderDaysBefore: 5,
    });
    const sent: number[] = [];
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async () => {
          sent.push(1);
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('does not fire for FULFILLED / DISMISSED / outside-window requests', async () => {
    const ctx = await seedContext();
    // Window: due is 10 days out, reminder is 3 — skip.
    await insertRequest({
      firmId: ctx.firmId,
      engagementId: ctx.engagementId,
      dueDate: '2026-06-11',
      reminderDaysBefore: 3,
    });
    // FULFILLED with fulfilled-by actor.
    await harness.db.execute(
      sql`INSERT INTO client_request
            (firm_id, engagement_id, title, status, due_date,
             reminder_days_before, fulfilled_at, fulfilled_by_app_user_id)
          VALUES (${ctx.firmId}, ${ctx.engagementId}, 'Done', 'FULFILLED',
                  '2026-06-02', 3, now(), ${ctx.appUserId})`,
    );
    // DISMISSED.
    await harness.db.execute(
      sql`INSERT INTO client_request
            (firm_id, engagement_id, title, status, due_date,
             reminder_days_before, dismissed_at)
          VALUES (${ctx.firmId}, ${ctx.engagementId}, 'Cancelled', 'DISMISSED',
                  '2026-06-02', 3, now())`,
    );
    const sent: number[] = [];
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async () => {
          sent.push(1);
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.scanned).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('idempotent within a day: second tick skips already-reminded rows', async () => {
    const ctx = await seedContext();
    await insertRequest({
      firmId: ctx.firmId,
      engagementId: ctx.engagementId,
      dueDate: '2026-06-03',
      reminderDaysBefore: 3,
    });
    let sentCount = 0;
    const dispatcher = async (): Promise<void> => {
      sentCount += 1;
    };
    const first = await runRequestReminderTick(
      harness.db,
      silentLog,
      { sendEmail: dispatcher },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(first.sent).toBe(1);
    const second = await runRequestReminderTick(
      harness.db,
      silentLog,
      { sendEmail: dispatcher },
      new Date('2026-06-01T18:00:00Z'),
    );
    // Same day — last_reminder_sent_at filter rejects the row.
    expect(second.scanned).toBe(0);
    expect(sentCount).toBe(1);
  });

  it('re-fires the next day after the previous send', async () => {
    const ctx = await seedContext();
    await insertRequest({
      firmId: ctx.firmId,
      engagementId: ctx.engagementId,
      dueDate: '2026-06-05',
      reminderDaysBefore: 5,
      lastReminderSentAt: '2026-05-31T08:00:00Z',
    });
    let sentCount = 0;
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async () => {
          sentCount += 1;
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.sent).toBe(1);
    expect(sentCount).toBe(1);
  });

  it('falls back to the primary contact when no isBilling contact exists', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Primary-only contact, no billing flag.
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Primary',
      email: 'primary@example.com',
      isPrimary: true,
    });
    await harness.db.execute(
      sql`INSERT INTO client_request
            (firm_id, engagement_id, title, status, due_date, reminder_days_before)
          VALUES (${seed.firmId}, ${seed.engagementId}, 'Send tax docs',
                  'OPEN', '2026-06-02', 3)`,
    );
    const sent: string[] = [];
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async (msg) => {
          sent.push(msg.to);
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.sent).toBe(1);
    expect(sent[0]).toBe('primary@example.com');
  });

  it('DROP_OFF sends both email and SMS to the billing contact', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Billing User',
      email: 'bill@example.com',
      mobile: '+15555550123',
      isPrimary: true,
      isBilling: true,
    });
    await insertRequest({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      dueDate: '2026-06-03',
      reminderDaysBefore: 3,
    });
    const emails: string[] = [];
    const texts: Array<{ to: string; body: string }> = [];
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async (msg) => {
          emails.push(msg.to);
        },
        sendSms: async (msg) => {
          texts.push({ to: msg.to, body: msg.body });
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.sent).toBe(1);
    expect(r.smsSent).toBe(1);
    expect(emails).toEqual(['bill@example.com']);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.to).toBe('+15555550123');
    expect(texts[0]!.body).toContain('drop off');
  });

  it('0224 — skips the SMS (but still emails) when the person opted out of texts', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const c = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Billing User',
      email: 'bill@example.com',
      mobile: '+15555550123',
      isPrimary: true,
      isBilling: true,
    });
    await harness.db.update(persons).set({ smsOptOut: true }).where(eq(persons.id, c.personId));
    await insertRequest({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      dueDate: '2026-06-03',
      reminderDaysBefore: 3,
    });
    const emails: string[] = [];
    const texts: string[] = [];
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async (msg) => {
          emails.push(msg.to);
        },
        sendSms: async (msg) => {
          texts.push(msg.to);
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.sent).toBe(1);
    expect(emails).toEqual(['bill@example.com']);
    expect(texts).toHaveLength(0);
  });

  it('DROP_OFF fires exactly once and does not re-fire the next day', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Billing User',
      email: 'bill@example.com',
      mobile: '+15555550123',
      isPrimary: true,
      isBilling: true,
    });
    await insertRequest({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      dueDate: '2026-06-05',
      reminderDaysBefore: 5,
    });
    let emailCount = 0;
    let smsCount = 0;
    const dispatch = {
      sendEmail: async (): Promise<void> => {
        emailCount += 1;
      },
      sendSms: async (): Promise<void> => {
        smsCount += 1;
      },
    };
    const first = await runRequestReminderTick(
      harness.db,
      silentLog,
      dispatch,
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(first.sent).toBe(1);
    // Next day, still inside the window — GENERAL would re-fire, DROP_OFF must not.
    const second = await runRequestReminderTick(
      harness.db,
      silentLog,
      dispatch,
      new Date('2026-06-02T08:00:00Z'),
    );
    expect(second.scanned).toBe(0);
    expect(emailCount).toBe(1);
    expect(smsCount).toBe(1);
  });

  it('DROP_OFF does not fire once overdue (window lower bound)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Billing User',
      email: 'bill@example.com',
      isPrimary: true,
      isBilling: true,
    });
    await insertRequest({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      dueDate: '2026-05-30', // already past relative to the tick below
      reminderDaysBefore: 3,
    });
    let emailCount = 0;
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async () => {
          emailCount += 1;
        },
        sendSms: async () => undefined,
      },
      new Date('2026-06-08T08:00:00Z'),
    );
    expect(r.scanned).toBe(0);
    expect(emailCount).toBe(0);
  });

  it('DROP_OFF preserves its once-only budget when the email send fails', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Billing User',
      email: 'bill@example.com',
      mobile: '+15555550123',
      isPrimary: true,
      isBilling: true,
    });
    await insertRequest({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      dueDate: '2026-06-05',
      reminderDaysBefore: 5,
    });
    // First tick: email throws → not stamped, not counted, SMS not sent.
    const fail = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async () => {
          throw new Error('smtp down');
        },
        sendSms: async () => undefined,
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(fail.sent).toBe(0);
    expect(fail.skipped).toBe(1);
    // Second tick next day: email recovers → the once-only nudge still fires.
    let emailCount = 0;
    let smsCount = 0;
    const ok = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async () => {
          emailCount += 1;
        },
        sendSms: async () => {
          smsCount += 1;
        },
      },
      new Date('2026-06-02T08:00:00Z'),
    );
    expect(ok.sent).toBe(1);
    expect(emailCount).toBe(1);
    expect(smsCount).toBe(1);
  });

  it('DROP_OFF still sends email when no phone is on file', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Billing User',
      email: 'bill@example.com',
      isPrimary: true,
      isBilling: true,
    });
    await insertRequest({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      dueDate: '2026-06-03',
      reminderDaysBefore: 3,
    });
    let emailCount = 0;
    let smsCount = 0;
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async () => {
          emailCount += 1;
        },
        sendSms: async () => {
          smsCount += 1;
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.sent).toBe(1);
    expect(r.smsSent).toBe(0);
    expect(emailCount).toBe(1);
    expect(smsCount).toBe(0);
  });

  it('skips when no email is resolvable for the client', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Contact exists but no email.
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'No email contact',
      isPrimary: true,
      isBilling: true,
    });
    await harness.db.execute(
      sql`INSERT INTO client_request
            (firm_id, engagement_id, title, status, due_date, reminder_days_before)
          VALUES (${seed.firmId}, ${seed.engagementId}, 'Send tax docs',
                  'OPEN', '2026-06-02', 3)`,
    );
    let sentCount = 0;
    const r = await runRequestReminderTick(
      harness.db,
      silentLog,
      {
        sendEmail: async () => {
          sentCount += 1;
        },
      },
      new Date('2026-06-01T08:00:00Z'),
    );
    expect(r.scanned).toBe(1);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(sentCount).toBe(0);
  });
});
