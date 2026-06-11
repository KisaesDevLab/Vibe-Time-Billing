// SPDX-License-Identifier: Elastic-2.0
//
// Unit tests for the pure state-machine planner in storage-sync.ts.
// These exercise every branch of the addendum's §4 Phase 3 state
// machine without touching Postgres or BullMQ. The orchestrator that
// applies the plan in a transaction is left for an integration test
// once the DB test harness lands.

import { describe, expect, it } from 'vitest';

import type { ReadSentinelResult, SentinelV1 } from '@vibe/storage';

import {
  decideSyncPlan,
  type ExistingFolderRow,
  type ObservedFolder,
  type OpenEventRow,
} from '../jobs/storage-sync';

const FIRM = '11111111-1111-1111-1111-111111111111';
const OTHER_FIRM = '22222222-2222-2222-2222-222222222222';
const CLIENT_A = '33333333-3333-3333-3333-333333333333';
const CLIENT_B = '44444444-4444-4444-4444-444444444444';
const CLIENT_UNKNOWN = '55555555-5555-5555-5555-555555555555';

function sentinel(overrides: Partial<SentinelV1> = {}): SentinelV1 {
  return {
    version: 1,
    client_id: CLIENT_A,
    firm_id: FIRM,
    tax_software_id: 'UT-0042',
    display_name_at_creation: 'Smith, John & Mary',
    created_at: '2026-05-21T12:00:00.000Z',
    created_by: null,
    ...overrides,
  };
}

function obs(
  path: string,
  result: Partial<ReadSentinelResult> & { ok?: boolean } = {},
): ObservedFolder {
  if (result.ok === true) {
    return {
      path,
      sentinel: {
        ok: true,
        payload: 'payload' in result && result.payload ? result.payload : sentinel(),
        etag: 'etag' in result && result.etag ? result.etag : 'e1',
      } as ReadSentinelResult,
    };
  }
  return {
    path,
    sentinel: result as ReadSentinelResult,
  };
}

function row(overrides: Partial<ExistingFolderRow> = {}): ExistingFolderRow {
  return {
    id: 'row-1',
    clientId: CLIENT_A,
    storagePath: 'Smith/',
    status: 'active',
    sentinelEtag: 'e1',
    ...overrides,
  };
}

const NO_OPEN: OpenEventRow[] = [];
const KNOWN_BOTH = new Set([CLIENT_A, CLIENT_B]);

describe('decideSyncPlan — fresh valid sentinel', () => {
  it('discovers and creates a row when no existing client_folders row matches', () => {
    const plan = decideSyncPlan({
      observed: [obs('Smith/', { ok: true, etag: 'e1' })],
      existing: [],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      rowId: null,
      clientId: CLIENT_A,
      storagePath: 'Smith/',
      status: 'active',
    });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventType: 'discovered',
      pathAfter: 'Smith/',
    });
  });

  it('no-ops when row exists at same path with matching etag', () => {
    const plan = decideSyncPlan({
      observed: [obs('Smith/', { ok: true, etag: 'e1' })],
      existing: [row()],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.upserts).toHaveLength(0);
    expect(plan.markStatus).toHaveLength(0);
    expect(plan.events).toHaveLength(0);
  });

  it('refreshes etag when content changed at same path (no event)', () => {
    const plan = decideSyncPlan({
      observed: [obs('Smith/', { ok: true, etag: 'e2' })],
      existing: [row({ sentinelEtag: 'e1' })],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({ sentinelEtag: 'e2', status: 'active' });
    expect(plan.events).toHaveLength(0);
  });
});

describe('decideSyncPlan — rename', () => {
  it('updates storage_path and logs renamed when sentinel shows up at a new path', () => {
    const plan = decideSyncPlan({
      observed: [obs('Smith Family Trust/', { ok: true, etag: 'e1' })],
      existing: [row({ storagePath: 'Smith/' })],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      rowId: 'row-1',
      storagePath: 'Smith Family Trust/',
      status: 'active',
    });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventType: 'renamed',
      pathBefore: 'Smith/',
      pathAfter: 'Smith Family Trust/',
    });
    // The old path is not in observed → no missing event because the
    // client_id was observed under a new path.
    expect(plan.events.find((e) => e.eventType === 'missing')).toBeUndefined();
  });
});

describe('decideSyncPlan — missing', () => {
  it('marks rows missing when their path was not observed and no rename covers them', () => {
    const plan = decideSyncPlan({
      observed: [],
      existing: [row()],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.markStatus).toHaveLength(1);
    expect(plan.markStatus[0]).toMatchObject({ rowId: 'row-1', status: 'missing' });
    expect(plan.events.find((e) => e.eventType === 'missing')).toBeDefined();
  });

  it('does not re-mark rows already in missing status', () => {
    const plan = decideSyncPlan({
      observed: [],
      existing: [row({ status: 'missing' })],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.markStatus).toHaveLength(0);
    expect(plan.events).toHaveLength(0);
  });
});

describe('decideSyncPlan — sentinel_lost', () => {
  it('logs sentinel_lost when row exists but sentinel file is gone, status stays active', () => {
    const plan = decideSyncPlan({
      observed: [obs('Smith/', { ok: false, reason: 'missing' } as ReadSentinelResult)],
      existing: [row()],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.markStatus).toHaveLength(0); // stays active
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventType: 'sentinel_lost',
      clientFolderId: 'row-1',
      pathAfter: 'Smith/',
    });
  });

  it('dedupes sentinel_lost when an open event already exists', () => {
    const plan = decideSyncPlan({
      observed: [obs('Smith/', { ok: false, reason: 'missing' } as ReadSentinelResult)],
      existing: [row()],
      knownClientIds: KNOWN_BOTH,
      openEvents: [{ eventType: 'sentinel_lost', clientFolderId: 'row-1', pathAfter: null }],
    });
    expect(plan.events).toHaveLength(0);
  });
});

describe('decideSyncPlan — unbound folders', () => {
  it('logs discovered for a folder with no sentinel and no row', () => {
    const plan = decideSyncPlan({
      observed: [obs('Stray/', { ok: false, reason: 'missing' } as ReadSentinelResult)],
      existing: [],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventType: 'discovered',
      clientFolderId: null,
      pathAfter: 'Stray/',
    });
  });

  it('dedupes discovered for unbound folders with an open event', () => {
    const plan = decideSyncPlan({
      observed: [obs('Stray/', { ok: false, reason: 'missing' } as ReadSentinelResult)],
      existing: [],
      knownClientIds: KNOWN_BOTH,
      openEvents: [{ eventType: 'discovered', clientFolderId: null, pathAfter: 'Stray/' }],
    });
    expect(plan.events).toHaveLength(0);
  });
});

describe('decideSyncPlan — conflict', () => {
  it('marks both folders conflict when two paths share the same client_id', () => {
    const plan = decideSyncPlan({
      observed: [
        obs('Smith/', { ok: true, etag: 'e1' }),
        obs('Smith (copy)/', { ok: true, etag: 'e2' }),
      ],
      existing: [row({ storagePath: 'Smith/' })],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(
      plan.markStatus.find((m) => m.rowId === 'row-1' && m.status === 'conflict'),
    ).toBeDefined();
    const conflictEvents = plan.events.filter((e) => e.eventType === 'conflict');
    expect(conflictEvents).toHaveLength(2);
    expect(conflictEvents.map((e) => e.pathAfter).sort()).toEqual(['Smith (copy)/', 'Smith/']);
  });
});

describe('decideSyncPlan — orphan + wrong_firm', () => {
  it('logs orphan when sentinel firm_id mismatches', () => {
    const plan = decideSyncPlan({
      observed: [
        obs('Foreign/', {
          ok: false,
          reason: 'wrong_firm',
          payload: sentinel({ firm_id: OTHER_FIRM }),
        } as ReadSentinelResult),
      ],
      existing: [],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventType: 'orphan',
      pathAfter: 'Foreign/',
    });
    expect(plan.upserts).toHaveLength(0);
  });

  it('logs discovered when sentinel valid but client_id unknown to this firm', () => {
    const plan = decideSyncPlan({
      observed: [
        obs('Unknown Client/', {
          ok: true,
          etag: 'e1',
          payload: sentinel({ client_id: CLIENT_UNKNOWN }),
        }),
      ],
      existing: [],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.upserts).toHaveLength(0);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventType: 'discovered',
      clientFolderId: null,
      pathAfter: 'Unknown Client/',
    });
  });
});

describe('decideSyncPlan — sentinel_changed', () => {
  it('logs sentinel_changed for unparseable JSON', () => {
    const plan = decideSyncPlan({
      observed: [
        obs('Broken/', {
          ok: false,
          reason: 'unparseable',
          error: 'unexpected token',
        } as ReadSentinelResult),
      ],
      existing: [row({ storagePath: 'Broken/' })],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventType: 'sentinel_changed',
      clientFolderId: 'row-1',
    });
  });
});

describe('decideSyncPlan — restored', () => {
  it('marks row active and logs restored when sentinel returns to a row previously missing', () => {
    const plan = decideSyncPlan({
      observed: [obs('Smith/', { ok: true, etag: 'e1' })],
      existing: [row({ status: 'missing' })],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    });
    expect(plan.markStatus).toHaveLength(1);
    expect(plan.markStatus[0]).toMatchObject({ rowId: 'row-1', status: 'active' });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventType: 'restored',
      clientFolderId: 'row-1',
    });
  });
});

describe('decideSyncPlan — idempotency', () => {
  it('produces no events when state is steady (active + matching etag)', () => {
    const inputs = {
      observed: [obs('Smith/', { ok: true, etag: 'e1' })],
      existing: [row()],
      knownClientIds: KNOWN_BOTH,
      openEvents: NO_OPEN,
    };
    const first = decideSyncPlan(inputs);
    const second = decideSyncPlan(inputs);
    expect(first.events).toHaveLength(0);
    expect(second.events).toHaveLength(0);
    expect(first.upserts).toHaveLength(0);
    expect(second.upserts).toHaveLength(0);
  });
});
