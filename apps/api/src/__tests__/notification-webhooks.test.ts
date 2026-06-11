// SPDX-License-Identifier: Elastic-2.0
//
// H.8 follow-up — exercise the three notification delivery webhook
// receivers (Postmark / Resend / Twilio) end-to-end via the in-process
// router. Verifies status lookup by provider_message_id, secret
// enforcement, and the not-configured fail-closed behavior.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type express from 'express';
import { pino } from 'pino';

import { buildPgliteHarness, type PgliteHarness } from './_pglite-harness';
import { notificationLog } from '@vibe/db/schema';
import { createNotificationWebhookRouter } from '../webhooks/notifications';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

const silentLog = pino({ enabled: false });

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  header(name: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function invoke(router: express.Router, path: string, req: FakeReq): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['post'] === true;
  });
  if (!layer) throw new Error(`route not registered: POST ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function seedSentRow(providerMessageId: string, channel: 'email' | 'sms'): Promise<string> {
  const [row] = await harness.db
    .insert(notificationLog)
    .values({
      channel,
      provider: channel === 'email' ? 'postmark' : 'twilio',
      recipient: channel === 'email' ? 'pat@example.com' : '+15551234567',
      subject: channel === 'email' ? 'Hi' : null,
      status: 'sent',
      providerMessageId,
    })
    .returning({ id: notificationLog.id });
  return row!.id;
}

function req(body: unknown, secret: string | null): FakeReq {
  const headers: Record<string, string> = secret ? { 'x-webhook-token': secret } : {};
  return {
    body,
    params: {},
    query: {},
    headers,
    header(name) {
      return headers[name.toLowerCase()];
    },
  };
}

describe('Notification delivery webhooks', () => {
  it('Postmark Delivery → status=delivered', async () => {
    const rowId = await seedSentRow('pm-msg-1', 'email');
    const router = createNotificationWebhookRouter({
      db: harness.db,
      log: silentLog,
      postmarkSecret: 'tok',
    });
    const r = await invoke(
      router,
      '/postmark',
      req({ RecordType: 'Delivery', MessageID: 'pm-msg-1' }, 'tok'),
    );
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { updated: boolean }).updated).toBe(true);
    const [row] = await harness.db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.id, rowId));
    expect(row!.status).toBe('delivered');
    expect(row!.deliveryUpdatedAt).not.toBeNull();
  });

  it('Postmark Bounce records error description', async () => {
    const rowId = await seedSentRow('pm-msg-2', 'email');
    const router = createNotificationWebhookRouter({
      db: harness.db,
      log: silentLog,
      postmarkSecret: 'tok',
    });
    await invoke(
      router,
      '/postmark',
      req({ RecordType: 'Bounce', MessageID: 'pm-msg-2', Description: 'mailbox full' }, 'tok'),
    );
    const [row] = await harness.db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.id, rowId));
    expect(row!.status).toBe('bounced');
    expect(row!.errorMessage).toBe('mailbox full');
  });

  it('Resend email.opened → status=opened', async () => {
    const rowId = await seedSentRow('resend-1', 'email');
    const router = createNotificationWebhookRouter({
      db: harness.db,
      log: silentLog,
      resendSecret: 'tok',
    });
    const r = await invoke(
      router,
      '/resend',
      req({ type: 'email.opened', data: { email_id: 'resend-1' } }, 'tok'),
    );
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.id, rowId));
    expect(row!.status).toBe('opened');
  });

  it('Twilio undelivered → status=bounced', async () => {
    const rowId = await seedSentRow('twilio-1', 'sms');
    const router = createNotificationWebhookRouter({
      db: harness.db,
      log: silentLog,
      twilioSecret: 'tok',
    });
    await invoke(
      router,
      '/twilio',
      req(
        {
          MessageSid: 'twilio-1',
          MessageStatus: 'undelivered',
          ErrorMessage: 'invalid number',
        },
        'tok',
      ),
    );
    const [row] = await harness.db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.id, rowId));
    expect(row!.status).toBe('bounced');
    expect(row!.errorMessage).toBe('invalid number');
  });

  it('rejects bad secret with 401', async () => {
    await seedSentRow('pm-msg-3', 'email');
    const router = createNotificationWebhookRouter({
      db: harness.db,
      log: silentLog,
      postmarkSecret: 'right-token',
    });
    const r = await invoke(
      router,
      '/postmark',
      req({ RecordType: 'Delivery', MessageID: 'pm-msg-3' }, 'wrong-token'),
    );
    expect(r.statusCode).toBe(401);
  });

  it('fails closed with 503 when secret unconfigured', async () => {
    const router = createNotificationWebhookRouter({
      db: harness.db,
      log: silentLog,
      postmarkSecret: null,
    });
    const r = await invoke(
      router,
      '/postmark',
      req({ RecordType: 'Delivery', MessageID: 'pm-msg-4' }, null),
    );
    expect(r.statusCode).toBe(503);
  });

  it('ignores unknown event types without 500', async () => {
    await seedSentRow('pm-msg-5', 'email');
    const router = createNotificationWebhookRouter({
      db: harness.db,
      log: silentLog,
      postmarkSecret: 'tok',
    });
    const r = await invoke(
      router,
      '/postmark',
      req({ RecordType: 'SubscriptionChange', MessageID: 'pm-msg-5' }, 'tok'),
    );
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { ignored: boolean }).ignored).toBe(true);
  });

  it('returns updated=false when provider_message_id is unknown', async () => {
    const router = createNotificationWebhookRouter({
      db: harness.db,
      log: silentLog,
      postmarkSecret: 'tok',
    });
    const r = await invoke(
      router,
      '/postmark',
      req({ RecordType: 'Delivery', MessageID: 'never-existed' }, 'tok'),
    );
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { updated: boolean }).updated).toBe(false);
  });
});
