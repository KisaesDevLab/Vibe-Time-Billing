// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// First-boot firm bootstrapper. The repo's seed.ts is a fully-loaded
// dev fixture ("Granite Peak CPAs" with sample staff, clients,
// adjustments, etc.). For a real CPA appliance install we want the
// minimum so the operator can sign in via magic link and start using
// the firm-settings UI to configure everything else.
//
// Inputs (env-passed, not flags — easier to drive from install.sh):
//   FIRM_NAME      e.g. "Smith & Co CPAs"
//   ADMIN_EMAIL    the email the first admin will sign in with
//   ADMIN_NAME     display name for the admin user (optional)
//
// What we insert (idempotent on firm name):
//   1. firm + firm_settings
//   2. one office ("Headquarters", America/Chicago — firm changes later)
//   3. admin app_user with the given email
//   4. role(name='admin', system_flag=true) + user_role link
//   5. four service lines (Tax / Audit / Advisory / Bookkeeping)
//   6. StandardRate rate_code (otherwise time entries can't price)
//   7. default notification templates + retainer tier configs (helpers
//      already exist for these)
//
// Engagement types, work codes, reason codes, clients, additional
// staff, and rates are all left for the operator to configure post-
// install via the admin UI.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

import {
  appUsers,
  clients,
  engagementLetterTemplates,
  engagementTemplates,
  engagementTypes,
  engagements,
  firmSettings,
  firms,
  offices,
  paymentMethodTypes,
  rateCodes,
  roles,
  serviceLines,
  taxJurisdictions,
  taxPaymentTypeCatalog,
  userRoles,
  workCodes,
} from '../schema/core';
import { seedNotificationTemplates } from '../seed-helpers/notification-templates';
import { seedRetainerTierConfigs } from '../seed-helpers/retainer-tier-configs';
import { seedKnowledgeBase } from '../seed-helpers/knowledge-base';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const firmName = (process.env['FIRM_NAME'] ?? '').trim();
  if (!firmName) throw new Error('FIRM_NAME is required (e.g. "Smith & Co CPAs")');

  const adminEmail = (process.env['ADMIN_EMAIL'] ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(adminEmail)) {
    throw new Error(`ADMIN_EMAIL must be a valid email (got: ${adminEmail || '<empty>'})`);
  }

  const adminName = (process.env['ADMIN_NAME'] ?? 'Firm Administrator').trim();

  // eslint-disable-next-line no-console
  console.log(`bootstrap: firm='${firmName}' admin='${adminEmail}'`);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  try {
    const existing = await db.select().from(firms).where(eq(firms.name, firmName)).limit(1);
    if (existing.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`bootstrap: firm '${firmName}' already exists — exiting cleanly`);
      return;
    }
    await db.transaction(async (tx) => {
      const [firmRow] = await tx
        .insert(firms)
        .values({ name: firmName, fiscalYearStartMonth: 1, defaultTermsDays: 30 })
        .returning({ id: firms.id });
      if (!firmRow) throw new Error('firm insert failed');
      const firmId = firmRow.id;

      await tx.insert(firmSettings).values({ firmId });

      const [officeRow] = await tx
        .insert(offices)
        .values({
          firmId,
          name: 'Headquarters',
          timezone: 'America/Chicago',
          isDefault: true,
        })
        .returning({ id: offices.id });
      if (!officeRow) throw new Error('office insert failed');

      const [adminUser] = await tx
        .insert(appUsers)
        .values({
          firmId,
          email: adminEmail,
          fullName: adminName,
          defaultOfficeId: officeRow.id,
        })
        .returning({ id: appUsers.id });
      if (!adminUser) throw new Error('admin user insert failed');

      const [adminRole] = await tx
        .insert(roles)
        .values({ firmId, name: 'admin', systemFlag: true })
        .returning({ id: roles.id });
      if (!adminRole) throw new Error('admin role insert failed');

      await tx.insert(userRoles).values({ appUserId: adminUser.id, roleId: adminRole.id });

      const serviceLineRows = await tx
        .insert(serviceLines)
        .values([
          { firmId, name: 'Tax', category: 'tax' as const, color: '#3b82f6' },
          { firmId, name: 'Audit', category: 'audit' as const, color: '#ef4444' },
          { firmId, name: 'Advisory', category: 'advisory' as const, color: '#22c55e' },
          { firmId, name: 'Bookkeeping', category: 'bookkeeping' as const, color: '#f59e0b' },
          { firmId, name: 'Payroll', category: 'payroll' as const, color: '#a855f7' },
        ])
        .returning({ id: serviceLines.id, category: serviceLines.category });
      // Map category → service_line_id so engagement types + work codes
      // can resolve their service line by category name in the JSON.
      const serviceLineByCategory = new Map(
        serviceLineRows.map((r) => [r.category as string, r.id]),
      );

      await tx.insert(rateCodes).values({
        firmId,
        code: 'StandardRate',
        description: 'Default billing rate',
        sortOrder: 0,
        isSystem: true,
      });

      // 0208 — permanent home for firm-administrative time: an Internal
      // service line, non-billable admin work codes, a visible internal
      // client, and one always-ACTIVE engagement flagged firm_admin (API
      // guards pin it ACTIVE and force its time entries non-billable).
      // Mirrors migration 0208, which no-ops on fresh installs because it
      // runs before this firm row exists.
      const [internalSl] = await tx
        .insert(serviceLines)
        .values({ firmId, name: 'Internal', category: 'internal', color: '#64748b' })
        .returning({ id: serviceLines.id });
      if (!internalSl) throw new Error('internal service line insert failed');
      await tx.insert(workCodes).values(
        [
          { key: 'admin_general', name: 'Administration' },
          { key: 'admin_cpe', name: 'CPE / Training' },
          { key: 'admin_meeting', name: 'Internal meeting' },
          { key: 'admin_marketing', name: 'Marketing / Business development' },
        ].map((wc) => ({
          firmId,
          serviceLineId: internalSl.id,
          key: wc.key,
          name: wc.name,
          billableDefault: false,
        })),
      );
      const [internalType] = await tx
        .insert(engagementTypes)
        .values({
          firmId,
          serviceLineId: internalSl.id,
          key: 'internal_admin',
          name: 'Internal — Administrative',
          defaultFeeStructure: 'HOURLY',
        })
        .returning({ id: engagementTypes.id });
      const [internalClient] = await tx
        .insert(clients)
        .values({
          firmId,
          name: '⚙ Firm — Internal',
          partnerInChargeId: adminUser.id,
          officeId: officeRow.id,
        })
        .returning({ id: clients.id });
      if (!internalClient) throw new Error('internal client insert failed');
      await tx.insert(engagements).values({
        clientId: internalClient.id,
        name: 'Administrative time',
        feeStructure: 'HOURLY',
        status: 'ACTIVE',
        engagementTypeId: internalType?.id ?? null,
        firmAdmin: true,
      });

      // Q24 starter pack — load the eight engagement templates from
      // seed/engagement-templates.json + their matching letter MDs.
      // Inserted in dependency order: work_codes → letter_templates →
      // engagement_types → engagement_templates (the template row
      // references all three).
      const starterPack = loadStarterPack();
      if (starterPack) {
        const { templates, letters } = starterPack;

        // Deduplicate work codes by key; assign each to the first
        // service-line category the key appears under. Operators can
        // re-bucket via the admin UI later.
        const workCodeByKey = new Map<
          string,
          { key: string; name: string; serviceLineId: string | null; billableDefault: boolean }
        >();
        for (const t of templates) {
          const slId = serviceLineByCategory.get(t.service_line_category) ?? null;
          for (const wc of t.work_codes) {
            if (workCodeByKey.has(wc.key)) continue;
            workCodeByKey.set(wc.key, {
              key: wc.key,
              name: wc.name,
              serviceLineId: slId,
              billableDefault: wc.billable_default,
            });
          }
        }
        const workCodeValues = Array.from(workCodeByKey.values());
        const workCodeRows = workCodeValues.length
          ? await tx
              .insert(workCodes)
              .values(
                workCodeValues.map((w) => ({
                  firmId,
                  serviceLineId: w.serviceLineId,
                  key: w.key,
                  name: w.name,
                  billableDefault: w.billableDefault,
                })),
              )
              .returning({ id: workCodes.id, key: workCodes.key })
          : [];
        const workCodeIdByKey = new Map(workCodeRows.map((r) => [r.key, r.id]));
        // eslint-disable-next-line no-console
        console.log(`bootstrap: seeded ${workCodeRows.length} work code(s)`);

        // Letter templates — one per .md file. Skip silently if the
        // template references a letter key that isn't on disk; the
        // template will land with default_letter_template_id NULL.
        const letterRows = letters.length
          ? await tx
              .insert(engagementLetterTemplates)
              .values(
                letters.map((l) => ({
                  firmId,
                  key: l.key,
                  name: l.name,
                  bodyHtml: l.body,
                  isSystem: true,
                })),
              )
              .returning({ id: engagementLetterTemplates.id, key: engagementLetterTemplates.key })
          : [];
        const letterIdByKey = new Map(letterRows.map((r) => [r.key, r.id]));
        // eslint-disable-next-line no-console
        console.log(`bootstrap: seeded ${letterRows.length} engagement letter template(s)`);

        // Engagement types — one per JSON template. Service line by
        // category; the templateData blob keeps any extra fields we
        // don't normalize into columns yet (milestones, custom fields).
        const engTypeRows = await tx
          .insert(engagementTypes)
          .values(
            templates.map((t) => ({
              firmId,
              serviceLineId: serviceLineByCategory.get(t.service_line_category) ?? null,
              key: t.key,
              name: t.name,
              defaultFeeStructure: t.default_fee_structure,
              defaultBudgetHours:
                t.default_budget_hours != null ? String(t.default_budget_hours) : null,
              autoRolloverDefault: t.auto_rollover_default ?? false,
              templateData: extractTemplateExtras(t),
            })),
          )
          .returning({ id: engagementTypes.id, key: engagementTypes.key });
        const engTypeIdByKey = new Map(engTypeRows.map((r) => [r.key, r.id]));
        // eslint-disable-next-line no-console
        console.log(`bootstrap: seeded ${engTypeRows.length} engagement type(s)`);

        // Engagement templates — link engagement_type, letter template,
        // and the in-scope work-code id array.
        await tx.insert(engagementTemplates).values(
          templates.map((t) => ({
            firmId,
            key: t.key,
            name: t.name,
            engagementTypeId: engTypeIdByKey.get(t.key) ?? null,
            defaultFeeStructure: t.default_fee_structure,
            defaultFeeAmountCents: t.default_fee_amount_cents ?? null,
            defaultBudgetHours:
              t.default_budget_hours != null ? String(t.default_budget_hours) : null,
            inScopeWorkCodeIds: t.work_codes
              .filter((wc) => wc.in_scope_default)
              .map((wc) => workCodeIdByKey.get(wc.key))
              .filter((id): id is string => id != null),
            defaultLetterTemplateId: t.engagement_letter_template_key
              ? (letterIdByKey.get(t.engagement_letter_template_key) ?? null)
              : null,
            isSystem: true,
          })),
        );
        // eslint-disable-next-line no-console
        console.log(`bootstrap: seeded ${templates.length} engagement template(s)`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          'bootstrap: starter pack not found on disk — engagement types will be empty (configure via admin UI)',
        );
      }

      const tplCount = await seedNotificationTemplates(tx, firmId);
      // eslint-disable-next-line no-console
      console.log(`bootstrap: seeded ${tplCount} notification template default(s)`);

      const tierCount = await seedRetainerTierConfigs(tx, firmId);
      // eslint-disable-next-line no-console
      console.log(`bootstrap: seeded ${tierCount} retainer tier config default(s)`);

      const kb = await seedKnowledgeBase(tx, firmId);
      // eslint-disable-next-line no-console
      console.log(
        `bootstrap: seeded knowledge base (${kb.categories} categories, ${kb.articles} articles)`,
      );

      // 0089 — payment-method catalog built-ins. Matches the previously
      // hard-coded RECORD_METHODS list on PaymentReceive. is_system=true
      // means these rows can be renamed/deactivated but not deleted.
      await tx
        .insert(paymentMethodTypes)
        .values([
          { firmId, key: 'CHECK', label: 'Check', displayOrder: 10, isSystem: true },
          { firmId, key: 'CASH', label: 'Cash', displayOrder: 20, isSystem: true },
          { firmId, key: 'ACH_MANUAL', label: 'ACH (manual)', displayOrder: 30, isSystem: true },
          { firmId, key: 'OTHER', label: 'Other', displayOrder: 99, isSystem: true },
        ])
        .onConflictDoNothing();
      // eslint-disable-next-line no-console
      console.log('bootstrap: seeded 4 payment method type default(s)');

      // 0090 — Tax jurisdiction + payment type catalog. Federal +
      // a starter pack of 5 common federal payment types. Firms add
      // their own state / local jurisdictions from the admin UI.
      const [federal] = await tx
        .insert(taxJurisdictions)
        .values({ firmId, name: 'Federal', displayOrder: 10, isSystem: true })
        .onConflictDoNothing()
        .returning({ id: taxJurisdictions.id });
      if (federal) {
        await tx
          .insert(taxPaymentTypeCatalog)
          .values([
            {
              firmId,
              jurisdictionId: federal.id,
              name: 'Income Tax',
              paymentUrl: 'https://www.irs.gov/payments',
              displayOrder: 10,
              isSystem: true,
            },
            {
              firmId,
              jurisdictionId: federal.id,
              name: 'Estimated Tax',
              paymentUrl: 'https://www.eftps.gov',
              displayOrder: 20,
              isSystem: true,
            },
            {
              firmId,
              jurisdictionId: federal.id,
              name: 'Tax Notice',
              paymentUrl: 'https://www.irs.gov/payments',
              displayOrder: 30,
              isSystem: true,
            },
            {
              firmId,
              jurisdictionId: federal.id,
              name: 'Extension',
              paymentUrl: 'https://www.irs.gov/payments/extension-of-time-to-file',
              displayOrder: 40,
              isSystem: true,
            },
            {
              firmId,
              jurisdictionId: federal.id,
              name: 'Payroll Tax',
              paymentUrl: 'https://www.eftps.gov',
              displayOrder: 50,
              isSystem: true,
            },
          ])
          .onConflictDoNothing();
        // eslint-disable-next-line no-console
        console.log('bootstrap: seeded Federal jurisdiction + 5 tax payment types');
      }
    });
    // eslint-disable-next-line no-console
    console.log(`bootstrap: '${firmName}' ready. Sign in at the admin URL using ${adminEmail}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('bootstrap: failed —', err instanceof Error ? err.message : err);
  process.exit(1);
});

// Type used by seed-helpers (drizzle's transaction param shape).
export type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

// ---------------------------------------------------------------------
// Q24 starter pack loader.
//
// The JSON + letter MDs live at `seed/` at the repo root. The Dockerfile
// copies them into `/app/seed` so the script can find them inside the
// runtime container. Resolution order:
//
//   1. SEED_DIR env var (operator override, for tests / unusual layouts)
//   2. Path relative to this script (../../../../seed from
//      packages/db/dist/scripts/bootstrap-firm.js → repo-root/seed in
//      both the image and a local checkout)
//   3. /app/seed (last-ditch absolute path inside the appliance image)
//
// If none of those resolve, we log a warning and skip the starter pack
// without failing the bootstrap — the firm just lands with empty
// engagement types and the operator configures them in the admin UI.
// ---------------------------------------------------------------------

const SUPPORTED_FEE_STRUCTURES = [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_WITH_MILESTONES',
  'RECURRING_SUBSCRIPTION',
] as const;
type FeeStructure = (typeof SUPPORTED_FEE_STRUCTURES)[number];

interface StarterPackTemplate {
  key: string;
  name: string;
  service_line_category: string;
  default_fee_structure: FeeStructure;
  default_fee_amount_cents?: number | null;
  default_budget_hours?: number | null;
  auto_rollover_default?: boolean;
  work_codes: Array<{
    key: string;
    name: string;
    billable_default: boolean;
    in_scope_default: boolean;
  }>;
  engagement_letter_template_key?: string;
  // Catch-all for fields we forward into engagement_type.template_data
  // (milestones, custom fields, partner-review flag, price-increase
  // pct, etc.) without normalizing them into columns yet.
  [key: string]: unknown;
}

interface StarterPackLetter {
  key: string;
  name: string;
  body: string;
}

interface StarterPack {
  templates: StarterPackTemplate[];
  letters: StarterPackLetter[];
}

function resolveSeedDir(): string | null {
  const envOverride = process.env['SEED_DIR'];
  if (envOverride && existsSync(envOverride)) return envOverride;
  try {
    // packages/db/dist/scripts/bootstrap-firm.js → ../../../../seed
    const here = dirname(fileURLToPath(import.meta.url));
    const fromScript = join(here, '..', '..', '..', '..', 'seed');
    if (existsSync(fromScript)) return fromScript;
  } catch {
    // fileURLToPath can throw on weird URLs; fall through to /app/seed.
  }
  if (existsSync('/app/seed')) return '/app/seed';
  return null;
}

function loadStarterPack(): StarterPack | null {
  const seedDir = resolveSeedDir();
  if (!seedDir) return null;
  const templatesPath = join(seedDir, 'engagement-templates.json');
  if (!existsSync(templatesPath)) return null;
  const raw = JSON.parse(readFileSync(templatesPath, 'utf8')) as {
    templates?: StarterPackTemplate[];
  };
  const templates = raw.templates ?? [];

  const lettersDir = join(seedDir, 'engagement-letters');
  const letters: StarterPackLetter[] = [];
  if (existsSync(lettersDir)) {
    for (const file of readdirSync(lettersDir)) {
      if (!file.endsWith('.md')) continue;
      const key = file.replace(/\.md$/, '');
      const body = readFileSync(join(lettersDir, file), 'utf8');
      // Friendly name: strip the el_ prefix and title-case.
      const name = key
        .replace(/^el_/, '')
        .split('_')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');
      letters.push({ key, name, body });
    }
  }
  return { templates, letters };
}

/**
 * Extra fields we don't normalize into engagement_type columns — milestones,
 * custom fields, partner-review flag, rollover price increase — stay in
 * `template_data` so the admin UI can surface them and a future migration
 * can promote them to dedicated columns without losing data.
 */
function extractTemplateExtras(t: StarterPackTemplate): Record<string, unknown> {
  const known = new Set([
    'key',
    'name',
    'service_line_category',
    'default_fee_structure',
    'default_fee_amount_cents',
    'default_budget_hours',
    'auto_rollover_default',
    'work_codes',
    'engagement_letter_template_key',
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (!known.has(k)) extras[k] = v;
  }
  return extras;
}
