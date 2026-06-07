/**
 * Vibe Time & Billing — System Template Library Loader
 *
 * Idempotent upsert of all system templates into the appliance database.
 * Safe to re-run on every appliance boot or `pnpm seed:templates`.
 *
 * Conflict resolution: ON CONFLICT (slug) DO UPDATE so shipped updates
 * propagate to the system_* tables. Firm-owned clones in services_catalog /
 * packages / terms_templates are not touched.
 *
 * Usage:
 *   import { loadSystemTemplates } from './seed';
 *   await loadSystemTemplates(db, { applianceVersion: '1.4.0' });
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { SERVICE_CATEGORIES } from './categories';
import { SYSTEM_SERVICE_TEMPLATES } from './services';
import { SYSTEM_PACKAGE_TEMPLATES } from './packages';
import { SYSTEM_TERMS_TEMPLATES } from './terms';
import { SYSTEM_EMAIL_TEMPLATES } from './emails';
import type { TemplatePackManifest } from './types';

/**
 * Bump this every time the shipped library changes.
 * Follow semver: major = breaking schema change, minor = new templates,
 * patch = wording fix on existing templates.
 */
export const TEMPLATES_PACK_VERSION = '1.0.0';

interface LoadOptions {
  applianceVersion: string;
  /** If true, log per-row upsert results. Default false. */
  verbose?: boolean;
}

interface LoadResult {
  manifest: TemplatePackManifest;
  upserts: {
    categories: number;
    services: number;
    packages: number;
    packageTiers: number;
    packageItems: number;
    terms: number;
    emails: number;
  };
  durationMs: number;
}

export async function loadSystemTemplates(
  db: PostgresJsDatabase,
  options: LoadOptions,
): Promise<LoadResult> {
  const start = Date.now();
  const v = TEMPLATES_PACK_VERSION;
  const verbose = options.verbose ?? false;
  const log = (msg: string) => verbose && console.log(`[seed] ${msg}`);

  const upserts = {
    categories: 0,
    services: 0,
    packages: 0,
    packageTiers: 0,
    packageItems: 0,
    terms: 0,
    emails: 0,
  };

  await db.transaction(async (tx) => {
    // ----- 1. Service categories ---------------------------------------------
    log(`Loading ${SERVICE_CATEGORIES.length} service categories`);
    for (const c of SERVICE_CATEGORIES) {
      await tx.execute(sql`
        INSERT INTO system_service_categories
          (slug, display_name, short_description, default_coa_code,
           default_coa_label, icon_hint, position)
        VALUES (${c.slug}, ${c.displayName}, ${c.shortDescription},
                ${c.defaultCoaCode}, ${c.defaultCoaLabel}, ${c.iconHint},
                ${c.position})
        ON CONFLICT (slug) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          short_description = EXCLUDED.short_description,
          default_coa_code = EXCLUDED.default_coa_code,
          default_coa_label = EXCLUDED.default_coa_label,
          icon_hint = EXCLUDED.icon_hint,
          position = EXCLUDED.position,
          updated_at = NOW()
      `);
      upserts.categories++;
    }

    // ----- 2. Service templates ---------------------------------------------
    log(`Loading ${SYSTEM_SERVICE_TEMPLATES.length} service templates`);
    for (const s of SYSTEM_SERVICE_TEMPLATES) {
      await tx.execute(sql`
        INSERT INTO system_service_templates
          (slug, category, name, description_md, billing_type,
           recurring_interval, default_price_cents,
           suggested_price_low_cents, suggested_price_high_cents,
           is_addon, tags, import_notes, pack_version)
        VALUES (${s.slug}, ${s.category}, ${s.name}, ${s.descriptionMd},
                ${s.billingType}, ${s.recurringInterval ?? null},
                ${s.defaultPriceCents},
                ${s.suggestedPriceRangeCents.low},
                ${s.suggestedPriceRangeCents.high},
                ${s.isAddon}, ${s.tags}, ${s.importNotes ?? null}, ${v})
        ON CONFLICT (slug) DO UPDATE SET
          category = EXCLUDED.category,
          name = EXCLUDED.name,
          description_md = EXCLUDED.description_md,
          billing_type = EXCLUDED.billing_type,
          recurring_interval = EXCLUDED.recurring_interval,
          default_price_cents = EXCLUDED.default_price_cents,
          suggested_price_low_cents = EXCLUDED.suggested_price_low_cents,
          suggested_price_high_cents = EXCLUDED.suggested_price_high_cents,
          is_addon = EXCLUDED.is_addon,
          tags = EXCLUDED.tags,
          import_notes = EXCLUDED.import_notes,
          pack_version = EXCLUDED.pack_version,
          updated_at = NOW()
      `);
      upserts.services++;
    }

    // ----- 3. Package templates + tiers + items ----------------------------
    log(`Loading ${SYSTEM_PACKAGE_TEMPLATES.length} package templates`);
    for (const p of SYSTEM_PACKAGE_TEMPLATES) {
      await tx.execute(sql`
        INSERT INTO system_package_templates
          (slug, name, primary_category, description_md, format,
           niche_tag, tags, import_notes, pack_version)
        VALUES (${p.slug}, ${p.name}, ${p.primaryCategory}, ${p.descriptionMd},
                ${p.format}, ${p.nicheTag}, ${p.tags}, ${p.importNotes}, ${v})
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          primary_category = EXCLUDED.primary_category,
          description_md = EXCLUDED.description_md,
          format = EXCLUDED.format,
          niche_tag = EXCLUDED.niche_tag,
          tags = EXCLUDED.tags,
          import_notes = EXCLUDED.import_notes,
          pack_version = EXCLUDED.pack_version,
          updated_at = NOW()
      `);
      upserts.packages++;

      // Replace-all strategy for tiers and items (cleaner than diffing).
      await tx.execute(sql`
        DELETE FROM system_package_template_tiers WHERE package_slug = ${p.slug}
      `);
      await tx.execute(sql`
        DELETE FROM system_package_template_items WHERE package_slug = ${p.slug}
      `);

      for (const t of p.tiers) {
        await tx.execute(sql`
          INSERT INTO system_package_template_tiers
            (package_slug, tier_slug, name, tagline, position)
          VALUES (${p.slug}, ${t.slug}, ${t.name}, ${t.tagline}, ${t.position})
        `);
        upserts.packageTiers++;
      }

      for (const item of p.items) {
        await tx.execute(sql`
          INSERT INTO system_package_template_items
            (package_slug, position, section, item_type, label,
             service_slug, tier_values)
          VALUES (${p.slug}, ${item.position}, ${item.section},
                  ${item.itemType}, ${item.label},
                  ${item.serviceSlug ?? null},
                  ${JSON.stringify(item.tierValues)}::jsonb)
        `);
        upserts.packageItems++;
      }
    }

    // ----- 4. Terms (engagement letter) templates --------------------------
    log(`Loading ${SYSTEM_TERMS_TEMPLATES.length} terms templates`);
    for (const t of SYSTEM_TERMS_TEMPLATES) {
      await tx.execute(sql`
        INSERT INTO system_terms_templates
          (slug, name, primary_category, body_md, source,
           standards_referenced, import_notes, pack_version)
        VALUES (${t.slug}, ${t.name}, ${t.primaryCategory}, ${t.bodyMd},
                ${t.source}, ${t.standardsReferenced},
                ${t.importNotes}, ${v})
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          primary_category = EXCLUDED.primary_category,
          body_md = EXCLUDED.body_md,
          source = EXCLUDED.source,
          standards_referenced = EXCLUDED.standards_referenced,
          import_notes = EXCLUDED.import_notes,
          pack_version = EXCLUDED.pack_version,
          updated_at = NOW()
      `);
      upserts.terms++;
    }

    // ----- 5. Email templates ----------------------------------------------
    log(`Loading ${SYSTEM_EMAIL_TEMPLATES.length} email templates`);
    for (const e of SYSTEM_EMAIL_TEMPLATES) {
      await tx.execute(sql`
        INSERT INTO system_email_templates
          (slug, kind, subject, body_md, plain_text_body, pack_version)
        VALUES (${e.slug}, ${e.kind}, ${e.subject}, ${e.bodyMd},
                ${e.plainTextBody ?? null}, ${v})
        ON CONFLICT (slug) DO UPDATE SET
          kind = EXCLUDED.kind,
          subject = EXCLUDED.subject,
          body_md = EXCLUDED.body_md,
          plain_text_body = EXCLUDED.plain_text_body,
          pack_version = EXCLUDED.pack_version,
          updated_at = NOW()
      `);
      upserts.emails++;
    }

    // ----- 6. Pack manifest -------------------------------------------------
    const manifest: TemplatePackManifest = {
      packVersion: v,
      shippedWithApplianceVersion: options.applianceVersion,
      generatedAt: new Date().toISOString(),
      counts: {
        categories: SERVICE_CATEGORIES.length,
        services: SYSTEM_SERVICE_TEMPLATES.length,
        packages: SYSTEM_PACKAGE_TEMPLATES.length,
        terms: SYSTEM_TERMS_TEMPLATES.length,
        emails: SYSTEM_EMAIL_TEMPLATES.length,
      },
    };

    await tx.execute(sql`
      INSERT INTO system_template_pack_manifest
        (pack_version, shipped_with_appliance_version,
         generated_at, counts)
      VALUES (${v}, ${options.applianceVersion},
              ${manifest.generatedAt},
              ${JSON.stringify(manifest.counts)}::jsonb)
    `);

    return manifest;
  });

  const durationMs = Date.now() - start;

  const manifest: TemplatePackManifest = {
    packVersion: v,
    shippedWithApplianceVersion: options.applianceVersion,
    generatedAt: new Date().toISOString(),
    counts: {
      categories: SERVICE_CATEGORIES.length,
      services: SYSTEM_SERVICE_TEMPLATES.length,
      packages: SYSTEM_PACKAGE_TEMPLATES.length,
      terms: SYSTEM_TERMS_TEMPLATES.length,
      emails: SYSTEM_EMAIL_TEMPLATES.length,
    },
  };

  log(`Done in ${durationMs}ms`);
  return { manifest, upserts, durationMs };
}

// =============================================================================
// Cloning helpers — used by the firm-side "Import to my catalog" flow
// =============================================================================

/**
 * Clone a system service template into the firm's services_catalog.
 *
 * Returns the new firm-owned service ID. Idempotent on
 * (firm_id, cloned_from_slug) — re-cloning is a no-op.
 *
 * The firm can then edit the clone freely without affecting the system template
 * or any other firm's catalog.
 */
export async function cloneServiceTemplate(
  _db: PostgresJsDatabase,
  _args: { firmId: string; templateSlug: string },
): Promise<string> {
  // Implementation deferred to firm-side flow (P02 of the addendum build plan).
  // Sketch:
  //   1. SELECT * FROM system_service_templates WHERE slug = $templateSlug
  //   2. INSERT INTO services_catalog (firm_id, name, description_md, ...,
  //      cloned_from_slug, cloned_from_pack_version) VALUES (...)
  //      ON CONFLICT (firm_id, cloned_from_slug) DO NOTHING
  //   3. RETURNING id
  throw new Error('cloneServiceTemplate: implement in build plan P02');
}

/**
 * Clone a system package template + its items into the firm's packages tables.
 *
 * For each `itemType='service'` line item with a serviceSlug, the corresponding
 * service template is also cloned (if not already cloned) and the package_services
 * junction row is created. For `itemType='experience'` line items, the row is
 * persisted as a free-text experience comparator on the firm's package.
 *
 * Returns the new firm-owned package ID.
 */
export async function clonePackageTemplate(
  _db: PostgresJsDatabase,
  _args: { firmId: string; templateSlug: string },
): Promise<string> {
  // Implementation deferred to firm-side flow (P03 of the addendum build plan).
  throw new Error('clonePackageTemplate: implement in build plan P03');
}

/**
 * Clone a system terms template into the firm's terms_templates table.
 */
export async function cloneTermsTemplate(
  _db: PostgresJsDatabase,
  _args: { firmId: string; templateSlug: string },
): Promise<string> {
  // Implementation deferred to firm-side flow (P07 of the addendum build plan).
  throw new Error('cloneTermsTemplate: implement in build plan P07');
}

// Re-exports for convenience.
export { SERVICE_CATEGORIES } from './categories';
export { SYSTEM_SERVICE_TEMPLATES, servicesByCategory } from './services';
export { SYSTEM_PACKAGE_TEMPLATES, packagesByPrimaryCategory } from './packages';
export { SYSTEM_TERMS_TEMPLATES } from './terms';
export { SYSTEM_EMAIL_TEMPLATES } from './emails';
export * from './types';
