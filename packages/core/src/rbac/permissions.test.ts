// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, it, expect } from 'vitest';

import { PERMISSION_KEYS, ROLE_TEMPLATES, hasPermission, unionPermissions } from './permissions';

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
