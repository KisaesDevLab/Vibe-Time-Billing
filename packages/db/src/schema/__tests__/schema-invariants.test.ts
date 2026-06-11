// SPDX-License-Identifier: Elastic-2.0
//
// Static schema invariant tests. These exercise Drizzle's table metadata
// without requiring a running Postgres — they verify column nullability,
// table separation, and structural promises in the spec.

import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';

import {
  timeEntries,
  appUsers,
  adjustmentAllocations,
  auditLog,
  firms,
  clients,
  engagements,
  timeEntryVersions,
} from '../core';
import { portalIdentity, clientPortalAccess, portalSession } from '../portal';

describe('schema invariants', () => {
  it('standard_rate_snapshot_cents is NOT NULL on time_entry', () => {
    const cols = getTableColumns(timeEntries);
    expect(cols.standardRateSnapshotCents.notNull).toBe(true);
    expect(cols.standardAmountCents.notNull).toBe(true);
  });

  it('app_user and portal_identity are distinct tables', () => {
    expect(getTableName(appUsers)).toBe('app_user');
    expect(getTableName(portalIdentity)).toBe('portal_identity');
    expect(getTableName(appUsers)).not.toBe(getTableName(portalIdentity));
  });

  it('adjustment_allocation captures per-timekeeper grain', () => {
    const cols = getTableColumns(adjustmentAllocations);
    // The non-negotiable grain: (adjustment_id, time_entry_id, app_user_id)
    expect(cols.adjustmentId.notNull).toBe(true);
    expect(cols.timeEntryId.notNull).toBe(true);
    expect(cols.appUserId.notNull).toBe(true);
  });

  it('audit_log has actor columns for both staff and portal realms', () => {
    const cols = getTableColumns(auditLog);
    expect(cols).toHaveProperty('actorAppUserId');
    expect(cols).toHaveProperty('actorPortalIdentityId');
  });

  it('portal_session is scoped to active_client_id', () => {
    const cols = getTableColumns(portalSession);
    expect(cols).toHaveProperty('portalIdentityId');
    expect(cols).toHaveProperty('activeClientId');
  });

  it('client_portal_access is the identity↔client many-to-many', () => {
    const cols = getTableColumns(clientPortalAccess);
    expect(cols).toHaveProperty('portalIdentityId');
    expect(cols).toHaveProperty('clientId');
    expect(cols).toHaveProperty('role');
  });

  it('time_entry_version is the append-only history table', () => {
    expect(getTableName(timeEntryVersions)).toBe('time_entry_version');
    const cols = getTableColumns(timeEntryVersions);
    expect(cols).toHaveProperty('timeEntryId');
    expect(cols).toHaveProperty('version');
  });

  it('firm and dependents carry firm_id on top-level tables', () => {
    expect(getTableColumns(clients)).toHaveProperty('firmId');
    expect(getTableColumns(engagements)).not.toHaveProperty('firmId'); // engagements link via client
    expect(getTableColumns(appUsers)).toHaveProperty('firmId');
    expect(getTableName(firms)).toBe('firm');
  });
});
