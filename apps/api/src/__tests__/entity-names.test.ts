// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared id → display-name resolution behind the activity / audit / log
// screens. The behaviour that matters: a name comes back for every kind we
// claim to cover, `thing.subthing` audit types resolve against the base
// kind, and a non-uuid actor string never reaches a uuid column.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  enrichWithNames,
  entityKey,
  isResolvableEntityType,
  resolveAppUserNames,
  resolveEntityNames,
} from '../lib/entity-names';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('resolveEntityNames', () => {
  it('resolves the common entity kinds to their display name', async () => {
    const names = await resolveEntityNames(harness.db, [
      { entityType: 'client', entityId: seed.clientId },
      { entityType: 'engagement', entityId: seed.engagementId },
      { entityType: 'app_user', entityId: seed.appUserId },
      { entityType: 'work_code', entityId: seed.workCodeId },
      { entityType: 'service_line', entityId: seed.serviceLineId },
    ]);
    expect(names.get(entityKey('client', seed.clientId))).toBe('Test Client Co');
    expect(names.get(entityKey('engagement', seed.engagementId))).toBe('Test Engagement');
    expect(names.get(entityKey('app_user', seed.appUserId))).toBe('Sarah Chen');
    expect(names.get(entityKey('work_code', seed.workCodeId))).toBe('Tax Preparation');
    expect(names.get(entityKey('service_line', seed.serviceLineId))).toBe('Tax');
  });

  it('resolves a `thing.subthing` audit type against the base kind', async () => {
    const names = await resolveEntityNames(harness.db, [
      { entityType: 'engagement.status', entityId: seed.engagementId },
    ]);
    expect(names.get(entityKey('engagement.status', seed.engagementId))).toBe('Test Engagement');
  });

  it('skips unknown kinds and null ids rather than throwing', async () => {
    const names = await resolveEntityNames(harness.db, [
      { entityType: 'firm_config', entityId: null },
      { entityType: 'not_a_real_kind', entityId: seed.clientId },
    ]);
    expect(names.size).toBe(0);
  });

  it('leaves a hard-deleted id unresolved so the caller can stub it', async () => {
    const names = await resolveEntityNames(harness.db, [
      { entityType: 'client', entityId: '00000000-0000-4000-8000-000000000000' },
    ]);
    expect(names.size).toBe(0);
  });
});

describe('resolveAppUserNames', () => {
  it('names staff ids and ignores non-uuid actor sentinels', async () => {
    // `system` / `opensign` / `signer:<id>` all flow through this call from
    // the signature activity trail — a non-uuid must not reach the query.
    const names = await resolveAppUserNames(harness.db, [
      seed.appUserId,
      'system',
      'opensign',
      `signer:${seed.appUserId}`,
      null,
    ]);
    expect(names.get(seed.appUserId)).toBe('Sarah Chen');
    expect(names.size).toBe(1);
  });
});

describe('enrichWithNames', () => {
  it('labels a staff actor and the entity they touched', async () => {
    const [row] = await enrichWithNames(harness.db, [
      {
        actorAppUserId: seed.appUserId,
        actorMcpTokenId: null,
        actorPortalIdentityId: null,
        entityType: 'client',
        entityId: seed.clientId,
      },
    ]);
    expect(row!.actorName).toBe('Sarah Chen');
    expect(row!.entityName).toBe('Test Client Co');
  });

  it('names a portal actor rather than falling back to "Portal user"', async () => {
    const ins = await harness.db.execute(
      sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
          VALUES (${seed.firmId}, 'Dana Client', 'dana@test.example') RETURNING id`,
    );
    const identityId = (ins as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const [row] = await enrichWithNames(harness.db, [
      {
        actorAppUserId: null,
        actorMcpTokenId: null,
        actorPortalIdentityId: identityId,
        entityType: 'client',
        entityId: seed.clientId,
      },
    ]);
    expect(row!.actorName).toBe('Dana Client (portal)');
  });

  it('returns null names — not a thrown error — for an unmapped kind', async () => {
    const [row] = await enrichWithNames(harness.db, [
      {
        actorAppUserId: null,
        actorMcpTokenId: null,
        actorPortalIdentityId: null,
        entityType: 'firm_config',
        entityId: null,
      },
    ]);
    expect(row!.actorName).toBeNull();
    expect(row!.entityName).toBeNull();
  });
});

describe('isResolvableEntityType', () => {
  it('covers the kinds the audit list actually records', () => {
    for (const t of ['service', 'service.tags', 'person', 'file', 'signature_request', 'office']) {
      expect(isResolvableEntityType(t)).toBe(true);
    }
    expect(isResolvableEntityType('firm_config')).toBe(false);
  });
});
