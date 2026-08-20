// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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

  // 0165 — per-client visibility restriction. Gates marking a client
  // "restricted" and editing its designated-user list. Admin (all keys)
  // + partner; managers do NOT get it.
  'client:restrict:manage',

  // Client credential vault (0159) — read includes revealing a secret
  // (gated additionally by a fresh step-up + audit at the route).
  'client:credential:read',
  'client:credential:write',
  'client:credential:delete',

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

  // Override gate — partners can manually promote/demote pay-to-unlock
  // escrow files without an underlying invoice payment (Connect F.7).
  // Distinct from invoice:void / payment:refund so a manager can void
  // an invoice without also being able to release the deliverable.
  'billing:override',

  // Credit memos (0056). Read = list/get; write = create + apply + void.
  'credit:read',
  'credit:write',

  // Reporting
  'report:realization:read',
  'report:utilization:read',
  'report:profitability:read',
  'report:ar:read',
  // Signed-forms report — completed e-signature requests with direct
  // links to signed PDFs + certificates. Partner + manager (admin inherits).
  'report:signed-forms:read',
  // Phase 17 #29 — partner-level data (book-of-business, partner
  // realization, partner profitability). Senior/staff don't get this.
  'report:partner-data:read',

  // Approvals
  'approval:queue:read',
  'approval:act',

  // 0146 — staged client-notification queue. Gates the Approvals-page
  // notification section and its send-now/schedule/cancel actions.
  // Separate from approval:act so firms can split who approves client
  // communications from who approves billing.
  'notification:approve',

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
  'storage:file:delete',

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

  // P02 (proposal addendum) — services catalog + tags. read for
  // partner + manager + senior (need to know what's billable when
  // logging time); write for partner + manager (pricing decisions
  // commit the firm).
  'service:read',
  'service:write',

  // P04 (proposal addendum) — proposal authoring. read for
  // partner + manager (see the pipeline); write for partner only
  // (proposals commit pricing + terms to a specific client). Once
  // signed, the engagement scope it creates is governed by
  // engagement:read|write (no separate agreement:* key per
  // QUESTIONS.md Q34 reasoning — agreement is just engagement +
  // engagement_scope post-acceptance).
  'proposal:read',
  'proposal:write',

  // 0096 — Support knowledge base. Reading is open to any authenticated
  // staff (no key); kb:manage gates create/edit/archive of articles +
  // categories. Granted to partner + manager (admin inherits all).
  'kb:manage',
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
    'client:restrict:manage',
    'client:credential:read',
    'client:credential:write',
    'client:credential:delete',
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
    'billing:override',
    'credit:read',
    'credit:write',
    'report:realization:read',
    'report:utilization:read',
    'report:profitability:read',
    'report:ar:read',
    'report:signed-forms:read',
    'report:partner-data:read',
    'approval:queue:read',
    'approval:act',
    'notification:approve',
    'admin:audit:read',
    // Storage v2 — Owner row in addendum §3.7 default matrix.
    'storage:folder:view',
    'storage:folder:edit',
    'storage:folder:rename',
    'storage:folder:bind',
    'storage:folder:reconcile',
    'storage:file:publish',
    'storage:file:unpublish',
    'storage:file:delete',
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
    'service:read',
    'service:write',
    'proposal:read',
    'proposal:write',
    'kb:manage',
  ]),

  manager: new Set<PermissionKey>([
    'office:read',
    'app_user:read',
    'taxonomy:read',
    'client:read',
    'client:write',
    'client:credential:read',
    'client:credential:write',
    'client:credential:delete',
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
    'report:signed-forms:read',
    'approval:queue:read',
    'approval:act',
    'notification:approve',
    // Storage v2 — Manager row. No reconcile (owner only).
    'storage:folder:view',
    'storage:folder:edit',
    'storage:folder:rename',
    'storage:folder:bind',
    'storage:file:publish',
    'storage:file:unpublish',
    'storage:file:delete',
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
    // P02 — manager has full services-catalog CRUD.
    'service:read',
    'service:write',
    // P04 — manager sees the pipeline read-only; only partners author.
    'proposal:read',
    'kb:manage',
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
    // P02 — senior reads catalog to pick services when logging time.
    'service:read',
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
    // P02 — staff reads catalog too (same time-entry use case).
    'service:read',
  ]),
};

export function unionPermissions(roles: ReadonlyArray<RoleSlug>): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const r of roles) {
    for (const p of ROLE_TEMPLATES[r]) out.add(p);
  }
  return out;
}

// 0147 — per-firm matrix deltas over the templates. granted=true adds
// a key the role's template lacks; granted=false revokes one it has.
export interface PermissionOverride {
  roleSlug: RoleSlug;
  permissionKey: string;
  granted: boolean;
}

/**
 * Effective permission set for a role: template ± its overrides. The
 * admin role ignores overrides — it always holds every key.
 */
export function effectiveRolePermissions(
  role: RoleSlug,
  overrides: ReadonlyArray<PermissionOverride>,
): Set<PermissionKey> {
  const out = new Set<PermissionKey>(ROLE_TEMPLATES[role]);
  if (role === 'admin') return out;
  const keys = new Set<string>(PERMISSION_KEYS);
  for (const o of overrides) {
    if (o.roleSlug !== role || !keys.has(o.permissionKey)) continue;
    if (o.granted) out.add(o.permissionKey as PermissionKey);
    else out.delete(o.permissionKey as PermissionKey);
  }
  return out;
}

/** unionPermissions with the firm's overrides applied per role first. */
export function unionPermissionsWithOverrides(
  roles: ReadonlyArray<RoleSlug>,
  overrides: ReadonlyArray<PermissionOverride>,
): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const r of roles) {
    for (const p of effectiveRolePermissions(r, overrides)) out.add(p);
  }
  return out;
}

export function hasPermission(
  userPermissions: ReadonlySet<PermissionKey>,
  required: PermissionKey,
): boolean {
  return userPermissions.has(required);
}
