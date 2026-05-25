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

  // Stage 1B — envelope encryption lifecycle. Unlock = enter the
  // admin passphrase at boot. Rotate = generate a new MFK and re-wrap
  // every T-DEK. Both gated to admin + partner.
  'crypto:unlock',
  'crypto:rotate',

  // Stage 2 — engagement messaging. Read/write split so a junior can
  // post in a thread without being able to remove members.
  'messaging:read',
  'messaging:write',

  // Stage 3 — client requests (document/info requests fulfilled by
  // staff or the client). 'manage' covers create/update/dismiss.
  'requests:read',
  'requests:manage',

  // R1 — Retainer addendum. tier_config:write is partner-only; read
  // surfaces to partner + manager. retainer:read covers dashboards.
  // retainer:write covers void + notes edit (R5).
  'retainer:tier_config:read',
  'retainer:tier_config:write',
  'retainer:read',
  'retainer:write',

  // CP1 — Tax Payments addendum. read for partner + manager (their
  // clients see what's scheduled); write for partner only (staff
  // cannot create or modify tax-payment rows).
  'tax_payment:read',
  'tax_payment:write',

  // CP12 — Appointments. read for partner + manager + staff (everyone
  // sees firm calendar entries for their assigned engagements);
  // write for partner + manager (any staff can be the lead but only
  // partners + managers can create / cancel).
  'appointment:read',
  'appointment:write',
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
    'crypto:unlock',
    'crypto:rotate',
    'messaging:read',
    'messaging:write',
    'requests:read',
    'requests:manage',
    'retainer:tier_config:read',
    'retainer:tier_config:write',
    'retainer:read',
    'retainer:write',
    'tax_payment:read',
    'tax_payment:write',
    'appointment:read',
    'appointment:write',
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
    'messaging:read',
    'messaging:write',
    'requests:read',
    'requests:manage',
    // R1 — manager can see tier configs + read retainers but cannot
    // edit tier configs or void retainers (partner-only).
    'retainer:tier_config:read',
    'retainer:read',
    // CP1 — manager sees scheduled tax payments but cannot create
    // or modify (partner-only write).
    'tax_payment:read',
    // CP12 — manager has full appointment CRUD.
    'appointment:read',
    'appointment:write',
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
    'messaging:read',
    'messaging:write',
    'requests:read',
    'requests:manage',
    // CP12 — senior can see appointments on their engagements.
    'appointment:read',
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
    'messaging:read',
    'messaging:write',
    'requests:read',
    // CP12 — staff see appointments on their assigned engagements.
    'appointment:read',
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
