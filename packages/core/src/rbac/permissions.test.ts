// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect } from 'vitest';

import {
  PERMISSION_KEYS,
  ROLE_TEMPLATES,
  effectiveRolePermissions,
  hasPermission,
  unionPermissions,
  unionPermissionsWithOverrides,
} from './permissions';

describe('PERMISSION_KEYS', () => {
  it('is non-empty and unique', () => {
    expect(PERMISSION_KEYS.length).toBeGreaterThan(20);
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('namespaced by entity (X:Y or X:Y:Z)', () => {
    for (const k of PERMISSION_KEYS) {
      expect(k).toMatch(/^[a-z_]+(:[a-z_-]+){1,3}$/);
    }
  });
});

describe('ROLE_TEMPLATES', () => {
  it('admin includes every permission', () => {
    expect(ROLE_TEMPLATES.admin.size).toBe(PERMISSION_KEYS.length);
  });

  it('staff cannot write invoices or approve adjustments', () => {
    expect(ROLE_TEMPLATES.staff.has('invoice:write')).toBe(false);
    expect(ROLE_TEMPLATES.staff.has('adjustment:approve')).toBe(false);
    expect(ROLE_TEMPLATES.staff.has('rate:write')).toBe(false);
  });

  it('manager cannot edit firm settings', () => {
    expect(ROLE_TEMPLATES.manager.has('firm:settings:write')).toBe(false);
  });

  it('partner can approve adjustments and edit rates', () => {
    expect(ROLE_TEMPLATES.partner.has('adjustment:approve')).toBe(true);
    expect(ROLE_TEMPLATES.partner.has('rate:write')).toBe(true);
  });

  it('notification:approve goes to partner and manager, not senior/staff', () => {
    expect(ROLE_TEMPLATES.partner.has('notification:approve')).toBe(true);
    expect(ROLE_TEMPLATES.manager.has('notification:approve')).toBe(true);
    expect(ROLE_TEMPLATES.senior.has('notification:approve')).toBe(false);
    expect(ROLE_TEMPLATES.staff.has('notification:approve')).toBe(false);
  });
});

describe('unionPermissions', () => {
  it('combines multiple role permission sets', () => {
    const merged = unionPermissions(['staff', 'manager']);
    expect(merged.has('time_entry:create')).toBe(true);
    expect(merged.has('report:realization:read')).toBe(true);
    expect(merged.has('firm:settings:write')).toBe(false);
  });

  it('hasPermission is a simple has() check', () => {
    const perms = unionPermissions(['partner']);
    expect(hasPermission(perms, 'adjustment:approve')).toBe(true);
    expect(hasPermission(perms, 'admin:mcp:manage')).toBe(false);
  });
});

describe('permission overrides (0147)', () => {
  it('grant adds a key the template lacks; revoke removes one it has', () => {
    const eff = effectiveRolePermissions('staff', [
      { roleSlug: 'staff', permissionKey: 'invoice:write', granted: true },
      { roleSlug: 'staff', permissionKey: 'time_entry:create', granted: false },
    ]);
    expect(eff.has('invoice:write')).toBe(true);
    expect(eff.has('time_entry:create')).toBe(false);
  });

  it('admin ignores overrides and unknown keys are dropped', () => {
    const eff = effectiveRolePermissions('admin', [
      { roleSlug: 'admin', permissionKey: 'invoice:write', granted: false },
    ]);
    expect(eff.size).toBe(PERMISSION_KEYS.length);
    const staff = effectiveRolePermissions('staff', [
      { roleSlug: 'staff', permissionKey: 'bogus:key', granted: true },
    ]);
    expect([...staff].includes('bogus:key' as never)).toBe(false);
  });

  it('overrides apply per role before the union', () => {
    const merged = unionPermissionsWithOverrides(
      ['staff', 'manager'],
      [{ roleSlug: 'manager', permissionKey: 'approval:act', granted: false }],
    );
    // staff never had approval:act; manager's was revoked.
    expect(merged.has('approval:act')).toBe(false);
    // unaffected manager grant still present.
    expect(merged.has('report:realization:read')).toBe(true);
  });
});
