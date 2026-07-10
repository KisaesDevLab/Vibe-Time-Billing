// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0161 — Web Push sender. Verifies: a live subscription is pushed and its
// lastUsedAt refreshed; a gone endpoint (HTTP 410) is pruned; and with no
// VAPID config it's a no-op.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  type PgliteHarness,
} from '../../../api/src/__tests__/_pglite-harness';
import { portalPushSubscription } from '@vibe/db/schema';

const sent: string[] = [];
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }) => {
      if (sub.endpoint.includes('dead')) {
        const e = new Error('gone') as Error & { statusCode: number };
        e.statusCode = 410;
        throw e;
      }
      sent.push(sub.endpoint);
      return {};
    }),
  },
}));

// Imported after the mock is declared so it picks up the mocked module.
const { sendWebPushToIdentity } = await import('../web-push');

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let identityId: string;

async function makeIdentity(): Promise<string> {
  const r = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name) VALUES (${seed.firmId}, 'Pat') RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function addSub(endpoint: string): Promise<void> {
  await harness.db.insert(portalPushSubscription).values({
    firmId: seed.firmId,
    portalIdentityId: identityId,
    endpoint,
    p256dh: 'pk',
    auth: 'ak',
  });
}

beforeEach(async () => {
  sent.length = 0;
  process.env['VAPID_PUBLIC_KEY'] = 'pub';
  process.env['VAPID_PRIVATE_KEY'] = 'priv';
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  identityId = await makeIdentity();
});

afterEach(async () => {
  await harness.close();
});

describe('sendWebPushToIdentity', () => {
  it('pushes live subscriptions and prunes gone ones', async () => {
    await addSub('https://push.example.com/live');
    await addSub('https://push.example.com/dead');

    const ok = await sendWebPushToIdentity(harness.db, identityId, {
      title: 'Hi',
      body: 'There',
      url: '/updates',
    });

    expect(ok).toBe(1);
    expect(sent).toEqual(['https://push.example.com/live']);

    const rows = await harness.db.select().from(portalPushSubscription);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toBe('https://push.example.com/live');
    expect(rows[0]!.lastUsedAt).not.toBeNull();
  });

  it('is a no-op with no subscriptions', async () => {
    const ok = await sendWebPushToIdentity(harness.db, identityId, {
      title: 'x',
      body: null,
      url: null,
    });
    expect(ok).toBe(0);
  });
});
