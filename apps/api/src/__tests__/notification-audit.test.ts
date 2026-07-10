// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Connect H.8 — verify the audit wrapper appends notification_log rows
// without changing the provider response shape.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { desc } from 'drizzle-orm';
import { pino } from 'pino';

import { buildPgliteHarness, type PgliteHarness } from './_pglite-harness';
import { notificationLog } from '@vibe/db/schema';
import { wrapMailWithAudit, wrapSmsWithAudit } from '../notifications/audit';
import type { MailProvider } from '../mail/provider';
import type { SmsProvider } from '../sms/provider';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

const silentLog = pino({ enabled: false });

function fakeMail(result: { ok: boolean; messageId?: string; error?: string }): MailProvider {
  return {
    id: 'console',
    async send() {
      return result;
    },
  };
}

function fakeSms(result: { ok: boolean; providerMessageId?: string; error?: string }): SmsProvider {
  return {
    id: 'console',
    async send() {
      return result;
    },
  };
}

describe('Notification audit wrap', () => {
  it('records a sent row for a successful mail send', async () => {
    const wrapped = wrapMailWithAudit(fakeMail({ ok: true, messageId: 'mid-1' }), {
      db: harness.db,
      log: silentLog,
    });
    const r = await wrapped.send({ to: 'pat@example.com', subject: 'Hi', body: 'Body' });
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe('mid-1');
    const rows = await harness.db
      .select()
      .from(notificationLog)
      .orderBy(desc(notificationLog.occurredAt));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe('email');
    expect(rows[0]!.provider).toBe('console');
    expect(rows[0]!.recipient).toBe('pat@example.com');
    expect(rows[0]!.subject).toBe('Hi');
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.providerMessageId).toBe('mid-1');
    expect(rows[0]!.errorMessage).toBeNull();
  });

  it('records a failed row when the underlying mail provider returns ok=false', async () => {
    const wrapped = wrapMailWithAudit(fakeMail({ ok: false, error: 'smtp connection refused' }), {
      db: harness.db,
      log: silentLog,
    });
    const r = await wrapped.send({ to: 'pat@example.com', subject: 'Hi', body: 'Body' });
    expect(r.ok).toBe(false);
    const [row] = await harness.db.select().from(notificationLog);
    expect(row!.status).toBe('failed');
    expect(row!.errorMessage).toBe('smtp connection refused');
    expect(row!.providerMessageId).toBeNull();
  });

  it('records sms sends', async () => {
    const wrapped = wrapSmsWithAudit(fakeSms({ ok: true, providerMessageId: 'sms-1' }), {
      db: harness.db,
      log: silentLog,
    });
    const r = await wrapped.send({ to: '+15551234567', body: 'code 123' });
    expect(r.ok).toBe(true);
    const [row] = await harness.db.select().from(notificationLog);
    expect(row!.channel).toBe('sms');
    expect(row!.recipient).toBe('+15551234567');
    expect(row!.subject).toBeNull();
    expect(row!.providerMessageId).toBe('sms-1');
  });

  it('respects resolveFirmId to scope rows', async () => {
    // Seed a firm so we have an FK target.
    const { sql } = await import('drizzle-orm');
    const r = await harness.db.execute(sql`INSERT INTO firm (name) VALUES ('Acme') RETURNING id`);
    const firmId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const wrapped = wrapMailWithAudit(fakeMail({ ok: true, messageId: 'mid-2' }), {
      db: harness.db,
      log: silentLog,
      resolveFirmId: async () => firmId,
    });
    await wrapped.send({ to: 'pat@example.com', subject: 'Hi', body: 'Body' });
    const [row] = await harness.db.select().from(notificationLog);
    expect(row!.firmId).toBe(firmId);
  });

  it('does not throw when db is null', async () => {
    const wrapped = wrapMailWithAudit(fakeMail({ ok: true, messageId: 'mid-3' }), {
      db: null,
      log: silentLog,
    });
    const r = await wrapped.send({ to: 'pat@example.com', subject: 'Hi', body: 'Body' });
    expect(r.ok).toBe(true);
  });
});
