// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0084 — runRequestReminderTick: emails the client billing contact
// when an OPEN / NEEDS_INFO request is within reminder_days_before
// of its due_date. Idempotent within a day via last_reminder_sent_at.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { pino } from 'pino';
import { eq, sql } from 'drizzle-orm';

import { clientRequests } from '@vibe/db/schema';
import { runRequestReminderTick } from '../../../worker/src/jobs/request-reminder';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';

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
  await harness.db.execute(
    sql`INSERT INTO client_contact (client_id, full_name, email, is_primary, is_billing)
        VALUES (${seed.clientId}, 'Billing User', 'bill@example.com', true, true)`,
  );
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
  dueDate: string | null;
  reminderDaysBefore: number | null;
  lastReminderSentAt?: string | null;
}): Promise<string> {
  const r = await harness.db.execute(
    sql`INSERT INTO client_request
          (firm_id, engagement_id, title, status, due_date,
           reminder_days_before, last_reminder_sent_at)
        VALUES (${args.firmId}, ${args.engagementId}, 'Send W-2',
                ${args.status ?? 'OPEN'}, ${args.dueDate},
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
    await harness.db.execute(
      sql`INSERT INTO client_contact (client_id, full_name, email, is_primary, is_billing)
          VALUES (${seed.clientId}, 'Primary', 'primary@example.com', true, false)`,
    );
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

  it('skips when no email is resolvable for the client', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Contact exists but no email.
    await harness.db.execute(
      sql`INSERT INTO client_contact (client_id, full_name, is_primary, is_billing)
          VALUES (${seed.clientId}, 'No email contact', true, true)`,
    );
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
