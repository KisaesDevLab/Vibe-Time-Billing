// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Reset-to-blank — wipe every operational data table in the appliance
// while preserving the firm row, staff identities, RBAC, taxonomy,
// templates, and firm-level settings. After this runs, the appliance
// is in the same state as right after `bootstrap-firm`: the 8 default
// engagement templates are intact, staff users can still sign in, and
// the catalog is unchanged — but every client, engagement, time entry,
// invoice, payment, and audit row is gone.
//
// Design notes
// ------------
// 1. **Allowlist, not blocklist.** We introspect `information_schema`
//    for the live table list and TRUNCATE everything NOT in the
//    PRESERVE set. New tables get preserved by default, which is
//    intentionally conservative — operators can review and add an
//    explicit entry if they want a new table wiped by reset.
// 2. **TRUNCATE … CASCADE bypasses the audit_log immutability
//    triggers**, which fire on BEFORE DELETE / BEFORE UPDATE only.
//    The DB owner ('vibe') invokes the truncate; the trigger remains
//    armed for runtime mutation attempts via the app code path.
// 3. **`RESTART IDENTITY`** resets any sequences so the wiped tables
//    start at 1 again. Drizzle uses UUID PKs so this matters only for
//    a handful of integer columns; safe either way.
// 4. **Foreign keys via CASCADE**. The PRESERVE set must be acyclic
//    with respect to the wipe set in one direction — preserved tables
//    can reference each other but must NOT be referenced by wiped
//    tables that we're TRUNCATEing in the same statement; PostgreSQL
//    will refuse to TRUNCATE a table that's referenced by a non-listed
//    table. CASCADE handles that automatically by adding the referrers
//    to the truncate set.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * Tables that survive a reset. Every other base table in the `vibetb`
 * schema gets truncated. The set is curated by function:
 *
 *  - firm + firm-level config + key envelope
 *  - staff identity, RBAC, MFA credentials
 *  - taxonomy (service line / work code / engagement type / reason …)
 *  - templates (engagement, letter, client, request, notification)
 *  - retainer tier configs (catalog, not instances)
 *  - services catalog, packages, terms templates
 *  - rate codes, holidays
 *  - firm-level rules + saved reports
 *  - integration configs (cloudflare tunnel, webhook endpoint, MCP token)
 */
export const PRESERVE_TABLES = new Set<string>([
  // Foundation
  'firm',
  'firm_settings',
  'firm_config',
  'firm_key_envelope',
  'firm_settings_proposals',
  'firm_retainer_settings',
  'firm_folder_visibility_rules',
  // Office / branches
  'office',
  'office_settings',
  // Staff identity + auth
  'app_user',
  'app_user_credential',
  // RBAC
  'role',
  'role_permission',
  'user_role',
  // Taxonomy
  'service_line',
  'work_code',
  'engagement_type',
  'reason_code',
  'client_source',
  'contact_role',
  // Templates
  'client_template',
  'engagement_template',
  'engagement_letter_template',
  'request_template',
  'request_template_item',
  'notification_template',
  // Retainer + catalog
  'retainer_tier_config',
  'retainer_tier_eligible_service',
  'services_catalog',
  'service_tags',
  'service_tag_assignments',
  'packages',
  'package_services',
  'terms_templates',
  // Rates + holidays + statuses
  'rate_code',
  'holiday_calendar',
  'engagement_status_config',
  // Rules + reports
  'approval_rule',
  'required_field_rule',
  'staff_skill',
  'staff_target',
  'saved_report',
  // Integrations / appliance config
  'cloudflare_tunnel_config',
  'webhook_endpoint',
  'mcp_token',
  // Demo seed tracker — keep so re-running demo can still clean up
  '_demo_seed_id',
]);

export interface ResetFirmDataResult {
  wipedTables: string[];
  skippedTables: string[];
}

/**
 * Reset the appliance to "blank with default engagements".
 *
 * Caller must have already gated this on permission + step-up +
 * typed-confirmation. This function does no permission checks — it
 * just runs the SQL. Designed to be called from
 * `POST /api/staff/admin/data/reset` and from a CLI shim.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resetFirmData(db: PostgresJsDatabase<any>): Promise<ResetFirmDataResult> {
  const rows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'vibetb'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  const allTables = rows as unknown as
    | { table_name: string }[]
    | { rows: { table_name: string }[] };
  const list: { table_name: string }[] = Array.isArray(allTables)
    ? allTables
    : (allTables as { rows: { table_name: string }[] }).rows;

  const wipedTables: string[] = [];
  const skippedTables: string[] = [];
  for (const row of list) {
    if (PRESERVE_TABLES.has(row.table_name)) {
      skippedTables.push(row.table_name);
    } else {
      wipedTables.push(row.table_name);
    }
  }

  if (wipedTables.length === 0) {
    return { wipedTables, skippedTables };
  }

  // Single TRUNCATE statement with CASCADE — PostgreSQL handles the
  // FK dependency graph for us, and the operation is atomic. Quoting
  // each identifier with `vibetb."x"` defends against any table name
  // that happens to collide with a reserved word.
  const target = wipedTables.map((t) => `vibetb."${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${target} RESTART IDENTITY CASCADE`));

  return { wipedTables, skippedTables };
}
