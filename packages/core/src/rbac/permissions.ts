// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Permission catalog. Keys are stable, namespaced strings. Role templates
// bundle permission keys; users may have multiple role assignments and
// the union applies.

export const PERMISSION_KEYS = [
  // Firm + office admin
  'firm:settings:read',
  'firm:settings:write',
  'office:read',
  'office:write',

  // Staff user admin
  'app_user:read',
  'app_user:invite',
  'app_user:write',
  'app_user:archive',

  // Taxonomy
  'taxonomy:read',
  'taxonomy:write',

  // Clients
  'client:read',
  'client:write',
  'client:archive',
  'client:portal-access:manage',

  // Engagements
  'engagement:read',
  'engagement:write',
  'engagement:archive',

  // Rates
  'rate:read',
  'rate:write',

  // Time entries
  'time_entry:create',
  'time_entry:read:own',
  'time_entry:read:all',
  'time_entry:update:own',
  'time_entry:update:any',
  'time_entry:delete:own',

  // Pre-bill / WIP / billing batches
  'billing_batch:read',
  'billing_batch:write',
  'billing_batch:approve',

  // Adjustments
  'adjustment:create',
  'adjustment:approve',
  'adjustment:reverse',

  // Invoicing
  'invoice:read',
  'invoice:write',
  'invoice:void',

  // Payments
  'payment:read',
  'payment:write',
  'payment:refund',

  // Credit memos (0056). Read = list/get; write = create + apply + void.
  'credit:read',
  'credit:write',

  // Reporting
  'report:realization:read',
  'report:utilization:read',
  'report:profitability:read',
  'report:ar:read',
  // Phase 17 #29 — partner-level data (book-of-business, partner
  // realization, partner profitability). Senior/staff don't get this.
  'report:partner-data:read',

  // Approvals
  'approval:queue:read',
  'approval:act',

  // MCP / AI / webhooks (admin-only)
  'admin:mcp:manage',
  'admin:webhooks:manage',
  'admin:ai:manage',
  'admin:audit:read',
  'admin:audit:export',
  'admin:backup:manage',

  // File-manager v2 (Phase 7 of FILE_MANAGER_ADDENDUM.md §3.7).
  // Asymmetric publish/unpublish on file.* so a junior can revoke a
  // mistake but can't expose anything new.
  'storage:folder:view',
  'storage:folder:edit',
  'storage:folder:rename',
  'storage:folder:bind',
  'storage:folder:reconcile',
  'storage:file:publish',
  'storage:file:unpublish',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type RoleSlug = 'partner' | 'manager' | 'senior' | 'staff' | 'admin';

export const ROLE_TEMPLATES: Record<RoleSlug, ReadonlySet<PermissionKey>> = {
  admin: new Set(PERMISSION_KEYS), // full access

  partner: new Set<PermissionKey>([
    'firm:settings:read',
    'office:read',
    'app_user:read',
    'taxonomy:read',
    'client:read',
    'client:write',
    'client:archive',
    'client:portal-access:manage',
    'engagement:read',
    'engagement:write',
    'engagement:archive',
    'rate:read',
    'rate:write',
    'time_entry:create',
    'time_entry:read:all',
    'time_entry:update:own',
    'time_entry:update:any',
    'billing_batch:read',
    'billing_batch:write',
    'billing_batch:approve',
    'adjustment:create',
    'adjustment:approve',
    'adjustment:reverse',
    'invoice:read',
    'invoice:write',
    'invoice:void',
    'payment:read',
    'payment:write',
    'payment:refund',
    'credit:read',
    'credit:write',
    'report:realization:read',
    'report:utilization:read',
    'report:profitability:read',
    'report:ar:read',
    'report:partner-data:read',
    'approval:queue:read',
    'approval:act',
    'admin:audit:read',
    // Storage v2 — Owner row in addendum §3.7 default matrix.
    'storage:folder:view',
    'storage:folder:edit',
    'storage:folder:rename',
    'storage:folder:bind',
    'storage:folder:reconcile',
    'storage:file:publish',
    'storage:file:unpublish',
  ]),

  manager: new Set<PermissionKey>([
    'office:read',
    'app_user:read',
    'taxonomy:read',
    'client:read',
    'client:write',
    'engagement:read',
    'engagement:write',
    'rate:read',
    'time_entry:create',
    'time_entry:read:all',
    'time_entry:update:own',
    'time_entry:update:any',
    'billing_batch:read',
    'billing_batch:write',
    'adjustment:create',
    'invoice:read',
    'invoice:write',
    'payment:read',
    'credit:read',
    'credit:write',
    'report:realization:read',
    'report:utilization:read',
    'report:profitability:read',
    'report:ar:read',
    'approval:queue:read',
    'approval:act',
    // Storage v2 — Manager row. No reconcile (owner only).
    'storage:folder:view',
    'storage:folder:edit',
    'storage:folder:rename',
    'storage:folder:bind',
    'storage:file:publish',
    'storage:file:unpublish',
  ]),

  senior: new Set<PermissionKey>([
    'taxonomy:read',
    'client:read',
    'engagement:read',
    'rate:read',
    'time_entry:create',
    'time_entry:read:all',
    'time_entry:update:own',
    'billing_batch:read',
    'invoice:read',
    'report:realization:read',
    'report:utilization:read',
    // Storage v2 — Bookkeeper row in addendum §3.7. View + edit
    // only; no rename/bind/publish. Keeps `unpublish` so a junior can
    // revoke a mistake.
    'storage:folder:view',
    'storage:folder:edit',
    'storage:file:unpublish',
  ]),

  staff: new Set<PermissionKey>([
    'taxonomy:read',
    'client:read',
    'engagement:read',
    'rate:read',
    'time_entry:create',
    'time_entry:read:own',
    'time_entry:update:own',
    // Storage v2 — Staff row. View + edit, unpublish-only on
    // visibility flips.
    'storage:folder:view',
    'storage:folder:edit',
    'storage:file:unpublish',
  ]),
};

export function unionPermissions(roles: ReadonlyArray<RoleSlug>): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const r of roles) {
    for (const p of ROLE_TEMPLATES[r]) out.add(p);
  }
  return out;
}

export function hasPermission(
  userPermissions: ReadonlySet<PermissionKey>,
  required: PermissionKey,
): boolean {
  return userPermissions.has(required);
}
