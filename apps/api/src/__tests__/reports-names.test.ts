// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Report rows resolve ids → names via the shared namesByIds helper.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { namesByIds } from '../reports/names';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

describe('reports namesByIds', () => {
  it('resolves appUser, client, and engagement names', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const users = await namesByIds(harness.db, [seed.appUserId], 'partner');
    expect(users.get(seed.appUserId)).toBeTruthy();
    const clientsMap = await namesByIds(harness.db, [seed.clientId], 'client');
    expect(clientsMap.get(seed.clientId)).toBeTruthy();
    const engsMap = await namesByIds(harness.db, [seed.engagementId], 'engagement');
    expect(engsMap.get(seed.engagementId)).toBeTruthy();
  });

  it('ignores null/empty ids and returns an empty map for none', async () => {
    const m = await namesByIds(harness.db, [null, undefined, ''], 'client');
    expect(m.size).toBe(0);
  });
});
