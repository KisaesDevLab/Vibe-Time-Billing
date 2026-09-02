// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — staff SMS inbox API: list filters + search + cursor, restricted
// clients hidden, detail/composer context, reply via the send service
// (confirms a suggested engagement), read/unread counters, assign/close/
// spam, link/unlink audit rows, bulk actions, templates (scope rules +
// render), unread-count, and the engagement/client surfaces.

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, persons, smsConversations, smsMessages, smsTemplates } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { createSmsInboxRouter } from '../sms/routes';
import type { SmsSendArgs, SmsSendResult, SmsSendService } from '../sms/send-service';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let lineId: string;
let sent: SmsSendArgs[];
let sendReply: (args: SmsSendArgs) => Promise<SmsSendResult>;
let events: string[];
const NUMBER = '+13125550148';

const fakeSend: SmsSendService = {
  async send(args) {
    sent.push(args);
    return sendReply(args);
  },
};

function app(userId = seed.appUserId, roles: Array<'admin' | 'staff'> = ['admin']) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    // reason: test stub — the real middleware attaches a full StaffSession
    req.staffSession = { firmId: seed.firmId, appUserId: userId } as never;
    next();
  });
  a.use(
    '/sms',
    createSmsInboxRouter({
      db: harness.db,
      smsSend: fakeSend,
      publish: (e) => {
        events.push(e.type);
      },
      fakeUserRoles: new Map([[userId, roles]]),
      redisUrl: null,
    }),
  );
  return a;
}

async function conv(
  extra: Partial<typeof smsConversations.$inferInsert> = {},
  messages: Array<{
    direction: 'inbound' | 'outbound';
    body: string;
    at?: string;
    readAt?: Date | null;
  }> = [],
): Promise<string> {
  const [c] = await harness.db
    .insert(smsConversations)
    .values({
      firmId: seed.firmId,
      lineId,
      externalNumberE164: NUMBER,
      lastMessageAt: new Date('2026-09-02T12:00:00Z'),
      ...extra,
    })
    .returning({ id: smsConversations.id });
  let i = 0;
  for (const m of messages) {
    i += 1;
    await harness.db.insert(smsMessages).values({
      firmId: seed.firmId,
      conversationId: c!.id,
      direction: m.direction,
      fromE164: m.direction === 'inbound' ? NUMBER : '+12025550100',
      toE164: m.direction === 'inbound' ? '+12025550100' : NUMBER,
      body: m.body,
      providerMessageId: `SM${c!.id.slice(0, 8)}${i}`,
      providerStatus: m.direction === 'inbound' ? 'received' : 'delivered',
      contextKind: m.direction === 'inbound' ? 'inbound' : 'manual',
      readAt: m.readAt ?? null,
      createdAt: new Date(m.at ?? `2026-09-02T11:0${i}:00Z`),
    });
  }
  return c!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  ({ lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId }));
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
  sent = [];
  events = [];
  sendReply = async () => ({ ok: true, mode: 'inbox', messageId: null, conversationId: null });
});

afterEach(async () => {
  await harness.close();
});

describe('SMS inbox routes', () => {
  it('lists with filters, search, and cursor; hides restricted clients', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Client',
      mobile: NUMBER,
    });
    const a = await conv(
      {
        personId,
        clientId: seed.clientId,
        unreadCount: 1,
        lastMessageAt: new Date('2026-09-02T12:00:00Z'),
      },
      [{ direction: 'inbound', body: 'need my W-2' }],
    );
    const b = await conv(
      {
        externalNumberE164: '+13125550199',
        unreadCount: 0,
        lastMessageAt: new Date('2026-09-02T11:00:00Z'),
      },
      [{ direction: 'inbound', body: 'hello?', readAt: new Date() }],
    );
    const c = await conv({
      externalNumberE164: '+13125550177',
      needsTriage: true,
      lastMessageAt: new Date('2026-09-02T10:00:00Z'),
    });
    const d = await conv({
      externalNumberE164: '+13125550166',
      status: 'spam',
      lastMessageAt: new Date('2026-09-02T09:00:00Z'),
    });
    const t = app();
    const all = await request(t).get('/sms/conversations');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3); // spam excluded from "all"
    expect(all.body.items.map((x: { id: string }) => x.id)).toEqual([a, b, c]);
    expect(all.body.items[0].contact.name).toBe('Pat Client');
    expect(all.body.items[0].lastMessagePreview).toBe('need my W-2');
    expect(all.body.items[0].lastDirection).toBe('inbound');
    expect(
      (await request(t).get('/sms/conversations?filter=unread')).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([a]);
    expect(
      (await request(t).get('/sms/conversations?filter=unassigned')).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([b, c]);
    expect(
      (await request(t).get('/sms/conversations?filter=triage')).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([c]);
    expect(
      (await request(t).get('/sms/conversations?status=spam')).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([d]);
    expect(
      (await request(t).get('/sms/conversations?q=w-2')).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([a]);
    expect(
      (await request(t).get('/sms/conversations?q=Pat')).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([a]);
    expect(
      (await request(t).get('/sms/conversations?q=5550199')).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([b]);
    const page1 = await request(t).get('/sms/conversations?limit=2');
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await request(t).get(
      `/sms/conversations?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.body.items.map((x: { id: string }) => x.id)).toEqual([c]);

    // Restricted client → hidden from a non-admin who isn't PIC / granted.
    await harness.db.execute(
      sql`UPDATE client SET restricted = true, partner_in_charge_id = ${seed.appUserId} WHERE id = ${seed.clientId}`,
    );
    const other = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name) VALUES (${seed.firmId}, 'x@test.example', 'Other Staff', 'Other', 'Staff') RETURNING id`,
    );
    const otherId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const asOther = await request(app(otherId, ['staff'])).get('/sms/conversations');
    expect(asOther.body.items.map((x: { id: string }) => x.id)).toEqual([b, c]);
    expect((await request(app(otherId, ['staff'])).get(`/sms/conversations/${a}`)).status).toBe(
      404,
    );
    expect((await request(t).get(`/sms/conversations/${a}`)).status).toBe(200); // PIC sees it
  });

  it('detail carries composer context; reply goes through the send service and confirms the suggested engagement', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Smith, Pat',
      mobile: NUMBER,
    });
    const id = await conv(
      {
        personId,
        clientId: seed.clientId,
        engagementId: seed.engagementId,
        engagementSuggested: true,
        lastInboundAt: new Date(),
        unreadCount: 1,
      },
      [{ direction: 'inbound', body: 'hi' }],
    );
    const t = app();
    const detail = await request(t).get(`/sms/conversations/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.engagement.suggested).toBe(true);
    expect(detail.body.canReply).toBe(true);
    expect(detail.body.templateVars.client_first).toBe('Pat');
    expect(detail.body.templateVars.staff_first).toBe('Sarah');
    expect(detail.body.templateVars.engagement_name).toBe('Test Engagement');
    expect(detail.body.engagementOptions).toHaveLength(1);
    sendReply = async () => ({ ok: true, mode: 'inbox', messageId: 'm1', conversationId: id });
    const r = await request(t).post(`/sms/conversations/${id}/messages`).send({ body: 'On it!' });
    expect(r.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.context).toMatchObject({
      kind: 'manual',
      conversationId: id,
      engagementId: seed.engagementId,
      sentByUserId: seed.appUserId,
    });
    const [c] = await harness.db.select().from(smsConversations).where(eq(smsConversations.id, id));
    expect(c!.engagementSuggested).toBe(false);
    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, 'sms_conversation'));
    expect(
      audits.some(
        (a) => (a.afterJson as { smsAction?: string })?.smsAction === 'confirm_engagement',
      ),
    ).toBe(true);
    // blocked send → 409 with the reason
    sendReply = async () => ({ ok: false, mode: 'inbox', reason: 'opted_out', personId });
    const blocked = await request(t)
      .post(`/sms/conversations/${id}/messages`)
      .send({ body: 'again' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('sms_opted_out');
    // closed conversations refuse replies
    await harness.db
      .update(smsConversations)
      .set({ status: 'closed' })
      .where(eq(smsConversations.id, id));
    expect(
      (await request(t).post(`/sms/conversations/${id}/messages`).send({ body: 'x' })).status,
    ).toBe(409);
  });

  it('read / unread / assign / close / bulk', async () => {
    const id = await conv({ unreadCount: 2 }, [
      { direction: 'inbound', body: 'one' },
      { direction: 'inbound', body: 'two' },
    ]);
    const t = app();
    expect((await request(t).get('/sms/unread-count')).body.unread).toBe(1);
    expect((await request(t).post(`/sms/conversations/${id}/read`)).status).toBe(200);
    let [c] = await harness.db.select().from(smsConversations).where(eq(smsConversations.id, id));
    expect(c!.unreadCount).toBe(0);
    expect(
      (await harness.db.select().from(smsMessages).where(eq(smsMessages.conversationId, id))).every(
        (m) => m.readAt,
      ),
    ).toBe(true);
    expect((await request(t).get('/sms/unread-count')).body.unread).toBe(0);
    expect((await request(t).post(`/sms/conversations/${id}/unread`)).status).toBe(200);
    [c] = await harness.db.select().from(smsConversations).where(eq(smsConversations.id, id));
    expect(c!.unreadCount).toBe(1);
    const patched = await request(t)
      .patch(`/sms/conversations/${id}`)
      .send({ assignedUserId: seed.appUserId, status: 'closed' });
    expect(patched.status).toBe(200);
    expect(patched.body.assignedUser.id).toBe(seed.appUserId);
    expect(patched.body.status).toBe('closed');
    const bulk = await request(t)
      .post('/sms/conversations/bulk')
      .send({ ids: [id], action: 'reopen' });
    expect(bulk.body.updated).toBe(1);
    [c] = await harness.db.select().from(smsConversations).where(eq(smsConversations.id, id));
    expect(c!.status).toBe('open');
    expect(events).toContain('sms.conversation.updated');
  });

  it('link → manual (with consent + number), unlink, rematch', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      email: 'pat@x.example',
    });
    const id = await conv({ lastInboundAt: new Date() }, [{ direction: 'inbound', body: 'hi' }]);
    const t = app();
    const linked = await request(t).post(`/sms/conversations/${id}/link`).send({
      clientId: seed.clientId,
      personId,
      engagementId: seed.engagementId,
      addNumberToContact: 'mobile',
    });
    expect(linked.status).toBe(200);
    expect(linked.body.client.id).toBe(seed.clientId);
    expect(linked.body.engagement.suggested).toBe(false);
    expect(linked.body.linkSource).toBe('manual');
    const [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.mobile).toBe(NUMBER);
    expect(p!.mobileE164).toBe(NUMBER);
    expect(p!.smsConsentSource).toBe('inbound');
    // manual link survives a rematch
    const re = await request(t).post(`/sms/conversations/${id}/rematch`);
    expect(re.body.result).toBe('manual');
    const un = await request(t).post(`/sms/conversations/${id}/unlink`);
    expect(un.body.client).toBeNull();
    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, 'sms_conversation'));
    const actions = audits.map((a) => (a.afterJson as { smsAction?: string })?.smsAction);
    expect(actions).toEqual(expect.arrayContaining(['link_client', 'rematch', 'unlink']));
    // engagement must belong to the client
    const bad = await request(t)
      .post(`/sms/conversations/${id}/link`)
      .send({ clientId: seed.clientId, engagementId: '00000000-0000-0000-0000-000000000001' });
    expect(bad.status).toBe(400);
  });

  it('new outbound conversation posts through the send service with a manual context', async () => {
    const t = app();
    sendReply = async (args) => {
      const [c] = await harness.db
        .insert(smsConversations)
        .values({ firmId: seed.firmId, lineId, externalNumberE164: args.to })
        .returning({ id: smsConversations.id });
      return { ok: true, mode: 'inbox', messageId: 'm', conversationId: c!.id };
    };
    const r = await request(t)
      .post('/sms/conversations')
      .send({ to: '(312) 555-0199', body: 'hello', clientId: seed.clientId });
    expect(r.status).toBe(201);
    expect(sent[0]!.to).toBe('+13125550199');
    expect(sent[0]!.context).toMatchObject({ kind: 'manual', clientId: seed.clientId });
    const [c] = await harness.db
      .select()
      .from(smsConversations)
      .where(eq(smsConversations.id, r.body.conversationId));
    expect(c!.linkSource).toBe('manual');
    sendReply = async () => ({ ok: false, mode: 'inbox', reason: 'no_consent', personId: 'p' });
    const blocked = await request(t)
      .post('/sms/conversations')
      .send({ to: '+13125550188', body: 'hi' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('sms_consent_required');
  });

  it('templates: user scope is private, firm scope needs settings permission, render substitutes', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: NUMBER,
    });
    const id = await conv({ personId, clientId: seed.clientId });
    const admin = app();
    const other = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name) VALUES (${seed.firmId}, 'y@test.example', 'Yolanda Staff', 'Yolanda', 'Staff') RETURNING id`,
    );
    const otherId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const staff = app(otherId, ['staff']);
    const mine = await request(staff)
      .post('/sms/templates')
      .send({ name: 'Thanks', body: 'Thanks {client_first}! — {staff_first}', scope: 'user' });
    expect(mine.status).toBe(201);
    expect(mine.body.variables).toEqual(['client_first', 'staff_first']);
    expect(
      (await request(staff).post('/sms/templates').send({ name: 'Firm', body: 'x', scope: 'firm' }))
        .status,
    ).toBe(403);
    const firmTpl = await request(admin)
      .post('/sms/templates')
      .send({ name: 'Firm', body: 'From {firm}', scope: 'firm' });
    expect(firmTpl.status).toBe(201);
    expect(
      (await request(admin).get('/sms/templates')).body.items.map((x: { name: string }) => x.name),
    ).toEqual(['Firm']);
    expect(
      (await request(staff).get('/sms/templates')).body.items.map((x: { name: string }) => x.name),
    ).toEqual(['Firm', 'Thanks']);
    const rendered = await request(staff)
      .post(`/sms/templates/${mine.body.id}/render`)
      .send({ conversationId: id });
    expect(rendered.body.text).toBe('Thanks Pat! — Yolanda');
    expect(rendered.body.unresolved).toEqual([]);
    expect((await request(admin).delete(`/sms/templates/${mine.body.id}`)).status).toBe(403);
    expect((await request(staff).delete(`/sms/templates/${mine.body.id}`)).status).toBe(200);
    const rows = await harness.db.select().from(smsTemplates);
    expect(rows.find((r) => r.name === 'Thanks')!.status).toBe('ARCHIVED');
  });

  it('engagement and client surfaces', async () => {
    const id = await conv({ clientId: seed.clientId, engagementId: seed.engagementId }, [
      { direction: 'inbound', body: 'a' },
      { direction: 'outbound', body: 'b' },
    ]);
    const t = app();
    const e = await request(t).get(`/sms/engagements/${seed.engagementId}/conversations`);
    expect(e.status).toBe(200);
    expect(e.body.conversations.map((x: { id: string }) => x.id)).toEqual([id]);
    expect(e.body.recent.map((m: { body: string }) => m.body)).toEqual(['a', 'b']);
    const c = await request(t).get(`/sms/clients/${seed.clientId}/conversations`);
    expect(c.body.items).toHaveLength(1);
  });
});
