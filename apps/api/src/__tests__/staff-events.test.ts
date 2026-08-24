// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2 — staff event stream: hello frame, counts delta → synthetic
// notification, staff_notification row → notification frame, poke makes
// the tick immediate, cleanup on close.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import { staffNotifications } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { categoryForType, createStaffEventsRouter } from '../notifications/staff-events';
import { pokeStaffEvents } from '../notifications/staff-events-bus';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
});
afterEach(async () => {
  await h.close();
});

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

class FakeRes extends EventEmitter {
  headers: Record<string, string> = {};
  statusCode = 200;
  writableEnded = false;
  chunks: string[] = [];
  status(c: number): this {
    this.statusCode = c;
    return this;
  }
  setHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  flushHeaders(): void {}
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  frames(): Frame[] {
    return this.chunks
      .join('')
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((b) => {
        const [evLine, dataLine] = b.split('\n');
        return {
          event: evLine!.slice('event: '.length),
          data: JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown>,
        };
      });
  }
}

function makeReq(): EventEmitter & Record<string, unknown> {
  const r = new EventEmitter() as EventEmitter & Record<string, unknown>;
  r['staffSession'] = { firmId: seed.firmId, appUserId: seed.appUserId };
  r['headers'] = {};
  return r;
}

async function open(pollMs = 10_000): Promise<{ req: ReturnType<typeof makeReq>; res: FakeRes }> {
  const router = createStaffEventsRouter({
    db: h.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    pollMs,
    heartbeatMs: 60_000,
  });
  const layer = router.stack.find((l) => l.route && (l.route as { path: string }).path === '/');
  type Handle = (rq: unknown, rs: unknown) => Promise<void>;
  const handle = (layer!.route as unknown as { stack: { handle: Handle }[] }).stack[0]!.handle;
  const req = makeReq();
  const res = new FakeRes();
  await handle(req, res);
  return { req, res };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await sleep(20);
  }
}

describe('staff events stream', () => {
  it('sends hello with counts and the SSE headers', async () => {
    const { req, res } = await open();
    expect(res.headers['Content-Type']).toContain('text/event-stream');
    const [hello] = res.frames();
    expect(hello!.event).toBe('hello');
    expect(hello!.data['counts']).toEqual({
      teamUnread: 0,
      notifUnread: 0,
      requestsNew: 0,
      intakeNew: 0,
    });
    req.emit('close');
  });

  it('pushes a new staff_notification row as a notification + counts frame on poke', async () => {
    const { req, res } = await open();
    await h.db.insert(staffNotifications).values({
      firmId: seed.firmId,
      recipientAppUserId: seed.appUserId,
      type: 'client_message_thread',
      entityType: 'thread',
      title: 'New message from Pat (Acme)',
      body: 'hello',
      actionUrl: `/clients/${seed.clientId}`,
    });
    pokeStaffEvents([seed.appUserId]);
    await waitFor(() => res.frames().some((f) => f.event === 'notification'));
    const frames = res.frames();
    const counts = frames.find((f) => f.event === 'counts');
    expect(counts?.data['notifUnread']).toBe(1);
    const notif = frames.find((f) => f.event === 'notification');
    expect(notif?.data['category']).toBe('message');
    expect(notif?.data['title']).toBe('New message from Pat (Acme)');
    expect(notif?.data['href']).toBe(`/clients/${seed.clientId}`);
    req.emit('close');
  });

  it('stops ticking after close', async () => {
    const { req, res } = await open();
    req.emit('close');
    expect(res.writableEnded).toBe(true);
    const before = res.chunks.length;
    pokeStaffEvents([seed.appUserId]);
    await sleep(50);
    expect(res.chunks.length).toBe(before);
  });
});

describe('categoryForType', () => {
  it('maps known notification types', () => {
    expect(categoryForType('client_message_thread')).toBe('message');
    expect(categoryForType('booking_request')).toBe('appointment');
    expect(categoryForType('reschedule_requested')).toBe('appointment');
    expect(categoryForType('signature_completed')).toBe('alert');
    expect(categoryForType('provider_write_failed')).toBe('alert');
  });
});
