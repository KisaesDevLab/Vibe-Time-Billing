// SPDX-License-Identifier: Elastic-2.0
//
// Clone engine for the system template library → firm catalog import.
// Reads the shipped, typed template data from @vibe/db/seed-helpers and
// inserts firm-owned, editable rows. Idempotent on cloned_from_slug (and on
// (firm,kind,channel) for emails), so re-importing skips what's already there.
//
// Mapping is intentionally lossy where the firm model is simpler than the
// shipped one (see notes inline) — the firm owns and edits the clone after.

import { and, eq, inArray, like } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientTemplates,
  engagementLetterTemplates,
  engagementTemplates,
  notificationTemplates,
  packages,
  packageServices,
  requestTemplateItems,
  requestTemplates,
  servicesCatalog,
  termsTemplates,
} from '@vibe/db/schema';
import {
  SERVICE_CATEGORY_DEFS,
  SYSTEM_CLIENT_TEMPLATES,
  SYSTEM_EMAIL_TEMPLATES,
  SYSTEM_ENGAGEMENT_TEMPLATES,
  SYSTEM_LETTER_TEMPLATES,
  SYSTEM_PACKAGE_TEMPLATES,
  SYSTEM_REQUEST_TEMPLATES,
  SYSTEM_SERVICE_TEMPLATES,
  SYSTEM_TERMS_TEMPLATES,
  TEMPLATES_PACK_VERSION,
  type BillingType,
  type RecurringInterval,
  type ServiceTemplate,
} from '@vibe/db/seed-helpers';

export type Area =
  | 'services'
  | 'packages'
  | 'terms'
  | 'emails'
  | 'engagements'
  | 'letters'
  | 'requests'
  | 'clients';

export interface ImportCounts {
  imported: number;
  skipped: number;
  total: number;
}

type FirmBillingType = 'ONE_TIME' | 'RECURRING' | 'ON_COMPLETION' | 'SPLIT_DEPOSIT_RECURRING';
type FirmInterval = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'ANNUALLY';

function mapInterval(i: RecurringInterval | undefined): FirmInterval {
  switch (i) {
    case 'quarterly':
      return 'QUARTERLY';
    case 'semi_annual':
      return 'SEMIANNUALLY';
    case 'annual':
      return 'ANNUALLY';
    // weekly has no firm equivalent → monthly is the closest cadence.
    case 'weekly':
    case 'monthly':
    default:
      return 'MONTHLY';
  }
}

/** Map shipped billing type → firm billing type + (consistent) interval. */
function mapBilling(s: ServiceTemplate): {
  billingType: FirmBillingType;
  recurringInterval: FirmInterval | null;
} {
  const bt: BillingType = s.billingType;
  if (bt === 'recurring') {
    return { billingType: 'RECURRING', recurringInterval: mapInterval(s.recurringInterval) };
  }
  if (bt === 'on_completion') {
    return { billingType: 'ON_COMPLETION', recurringInterval: null };
  }
  // on_acceptance | hourly | variable → a single one-time charge the firm can edit.
  return { billingType: 'ONE_TIME', recurringInterval: null };
}

function coaForCategory(category: string): string | null {
  return SERVICE_CATEGORY_DEFS.find((c) => c.slug === category)?.defaultCoaCode ?? null;
}

/** A package line item is "included" at a tier when its cell is a check / "Included". */
function isIncluded(val: string | undefined): boolean {
  if (!val) return false;
  return /^(✓|included)$/i.test(val.trim());
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

interface ServiceImportResult extends ImportCounts {
  /** slug → firm services_catalog id (existing or newly created). */
  idBySlug: Map<string, string>;
}

export async function importServices(
  db: Database,
  args: { firmId: string; appUserId: string; slugs?: string[] },
): Promise<ServiceImportResult> {
  const wanted = args.slugs?.length
    ? SYSTEM_SERVICE_TEMPLATES.filter((s) => args.slugs!.includes(s.slug))
    : SYSTEM_SERVICE_TEMPLATES;
  const idBySlug = new Map<string, string>();
  let imported = 0;
  let skipped = 0;
  if (wanted.length === 0) return { imported, skipped, total: 0, idBySlug };

  const existing = await db
    .select({ id: servicesCatalog.id, slug: servicesCatalog.clonedFromSlug })
    .from(servicesCatalog)
    .where(
      and(
        eq(servicesCatalog.firmId, args.firmId),
        inArray(
          servicesCatalog.clonedFromSlug,
          wanted.map((s) => s.slug),
        ),
      ),
    );
  for (const row of existing) if (row.slug) idBySlug.set(row.slug, row.id);

  for (const s of wanted) {
    if (idBySlug.has(s.slug)) {
      skipped++;
      continue;
    }
    const { billingType, recurringInterval } = mapBilling(s);
    const [row] = await db
      .insert(servicesCatalog)
      .values({
        firmId: args.firmId,
        name: s.name,
        description: s.descriptionMd,
        category: s.category,
        defaultPriceCents: s.defaultPriceCents,
        billingType,
        recurringInterval,
        isAddon: s.isAddon,
        coaCode: coaForCategory(s.category),
        clonedFromSlug: s.slug,
        clonedFromPackVersion: TEMPLATES_PACK_VERSION,
        createdById: args.appUserId,
      })
      .returning({ id: servicesCatalog.id });
    idBySlug.set(s.slug, row!.id);
    imported++;
  }
  return { imported, skipped, total: wanted.length, idBySlug };
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export async function importTerms(
  db: Database,
  args: { firmId: string; appUserId: string; slugs?: string[] },
): Promise<ImportCounts> {
  const wanted = args.slugs?.length
    ? SYSTEM_TERMS_TEMPLATES.filter((t) => args.slugs!.includes(t.slug))
    : SYSTEM_TERMS_TEMPLATES;
  let imported = 0;
  let skipped = 0;
  if (wanted.length === 0) return { imported, skipped, total: 0 };

  const existing = new Set(
    (
      await db
        .select({ slug: termsTemplates.clonedFromSlug })
        .from(termsTemplates)
        .where(
          and(
            eq(termsTemplates.firmId, args.firmId),
            inArray(
              termsTemplates.clonedFromSlug,
              wanted.map((t) => t.slug),
            ),
          ),
        )
    )
      .map((r) => r.slug)
      .filter((s): s is string => Boolean(s)),
  );

  for (const t of wanted) {
    if (existing.has(t.slug)) {
      skipped++;
      continue;
    }
    await db.insert(termsTemplates).values({
      firmId: args.firmId,
      category: t.primaryCategory,
      name: t.name,
      contentMd: t.bodyMd,
      isDefault: false,
      clonedFromSlug: t.slug,
      clonedFromPackVersion: TEMPLATES_PACK_VERSION,
      createdById: args.appUserId,
    });
    imported++;
  }
  return { imported, skipped, total: wanted.length };
}

// ---------------------------------------------------------------------------
// Packages — one firm package per tier; auto-imports referenced services and
// links the ones included at that tier. "Experience" comparator rows are
// folded into the package description (the firm package model has no per-tier
// comparison grid).
// ---------------------------------------------------------------------------

export async function importPackages(
  db: Database,
  args: { firmId: string; appUserId: string; slugs?: string[] },
): Promise<ImportCounts> {
  const wanted = args.slugs?.length
    ? SYSTEM_PACKAGE_TEMPLATES.filter((p) => args.slugs!.includes(p.slug))
    : SYSTEM_PACKAGE_TEMPLATES;
  let imported = 0;
  let skipped = 0;
  if (wanted.length === 0) return { imported, skipped, total: 0 };

  // Ensure every service referenced by the selected packages exists in the
  // firm catalog, and get slug → id.
  const referencedSlugs = Array.from(
    new Set(
      wanted.flatMap((p) =>
        p.items.filter((i) => i.itemType === 'service' && i.serviceSlug).map((i) => i.serviceSlug!),
      ),
    ),
  );
  const svc = await importServices(db, { ...args, slugs: referencedSlugs });
  const idBySlug = svc.idBySlug;

  // Which tier-packages already exist (cloned_from_slug = "<pkg>:<tier>").
  const tierSlugs = wanted.flatMap((p) => p.tiers.map((t) => `${p.slug}:${t.slug}`));
  const existing = new Set(
    (
      await db
        .select({ slug: packages.clonedFromSlug })
        .from(packages)
        .where(
          and(
            eq(packages.firmId, args.firmId),
            tierSlugs.length
              ? inArray(packages.clonedFromSlug, tierSlugs)
              : eq(packages.firmId, args.firmId),
          ),
        )
    )
      .map((r) => r.slug)
      .filter((s): s is string => Boolean(s)),
  );

  const total = tierSlugs.length;
  for (const p of wanted) {
    for (const tier of p.tiers) {
      const clonedSlug = `${p.slug}:${tier.slug}`;
      if (existing.has(clonedSlug)) {
        skipped++;
        continue;
      }
      // Experience rows (and non-included service rows) → description bullets.
      const bullets = p.items
        .filter((i) => {
          const v = i.tierValues[tier.slug];
          return v && v.trim() !== '' && v.trim() !== '—' && !isIncluded(v);
        })
        .sort((a, b) => a.position - b.position)
        .map((i) => `- ${i.label}: ${i.tierValues[tier.slug]}`);
      const description = [
        p.descriptionMd,
        tier.tagline ? `\n_${tier.tagline}_` : '',
        bullets.length ? `\n\n**Service levels & support**\n${bullets.join('\n')}` : '',
      ]
        .join('')
        .trim();

      const [pkgRow] = await db
        .insert(packages)
        .values({
          firmId: args.firmId,
          // All tiers of a package share the package name; tier_label
          // distinguishes them. The package_selector block groups by name.
          name: p.name,
          tierLabel: tier.name,
          position: tier.position,
          description,
          clonedFromSlug: clonedSlug,
          clonedFromPackVersion: TEMPLATES_PACK_VERSION,
          createdById: args.appUserId,
        })
        .returning({ id: packages.id });

      // Link the service items included at this tier.
      const includedServiceItems = p.items.filter(
        (i) => i.itemType === 'service' && i.serviceSlug && isIncluded(i.tierValues[tier.slug]),
      );
      for (const item of includedServiceItems) {
        const serviceId = idBySlug.get(item.serviceSlug!);
        if (!serviceId) continue;
        await db.insert(packageServices).values({
          packageId: pkgRow!.id,
          serviceId,
          included: true,
          sequence: item.position,
        });
      }
      imported++;
    }
  }
  return { imported, skipped, total };
}

// ---------------------------------------------------------------------------
// Emails → notification_template (EMAIL channel), keyed by kind.
// Insert-if-absent so firm edits are never clobbered.
// ---------------------------------------------------------------------------

export async function importEmails(
  db: Database,
  args: { firmId: string; slugs?: string[] },
): Promise<ImportCounts> {
  const wanted = args.slugs?.length
    ? SYSTEM_EMAIL_TEMPLATES.filter((e) => args.slugs!.includes(e.slug))
    : SYSTEM_EMAIL_TEMPLATES;
  let imported = 0;
  let skipped = 0;
  if (wanted.length === 0) return { imported, skipped, total: 0 };

  const kinds = wanted.map((e) => e.kind);
  const existing = new Set(
    (
      await db
        .select({ kind: notificationTemplates.kind })
        .from(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.firmId, args.firmId),
            eq(notificationTemplates.channel, 'EMAIL'),
            inArray(notificationTemplates.kind, kinds),
          ),
        )
    ).map((r) => r.kind),
  );

  for (const e of wanted) {
    if (existing.has(e.kind)) {
      skipped++;
      continue;
    }
    await db.insert(notificationTemplates).values({
      firmId: args.firmId,
      kind: e.kind,
      channel: 'EMAIL',
      subject: e.subject,
      body: e.bodyMd,
      enabled: true,
    });
    existing.add(e.kind); // guard against duplicate kinds within the pack
    imported++;
  }
  return { imported, skipped, total: wanted.length };
}

// ---------------------------------------------------------------------------
// Engagement templates → engagement_template. Fee structure maps 1:1.
// Returns slug → firm id so client-template import can resolve its
// suggested engagement slugs to real ids.
// ---------------------------------------------------------------------------

interface EngagementImportResult extends ImportCounts {
  idBySlug: Map<string, string>;
}

export async function importEngagements(
  db: Database,
  args: { firmId: string; appUserId: string; slugs?: string[] },
): Promise<EngagementImportResult> {
  const wanted = args.slugs?.length
    ? SYSTEM_ENGAGEMENT_TEMPLATES.filter((e) => args.slugs!.includes(e.slug))
    : SYSTEM_ENGAGEMENT_TEMPLATES;
  const idBySlug = new Map<string, string>();
  let imported = 0;
  let skipped = 0;
  if (wanted.length === 0) return { imported, skipped, total: 0, idBySlug };

  const existing = await db
    .select({ id: engagementTemplates.id, slug: engagementTemplates.clonedFromSlug })
    .from(engagementTemplates)
    .where(
      and(
        eq(engagementTemplates.firmId, args.firmId),
        inArray(
          engagementTemplates.clonedFromSlug,
          wanted.map((e) => e.slug),
        ),
      ),
    );
  for (const row of existing) if (row.slug) idBySlug.set(row.slug, row.id);

  for (const e of wanted) {
    if (idBySlug.has(e.slug)) {
      skipped++;
      continue;
    }
    const [row] = await db
      .insert(engagementTemplates)
      .values({
        firmId: args.firmId,
        key: e.slug,
        name: e.name,
        defaultFeeStructure: e.defaultFeeStructure,
        defaultFeeAmountCents: e.defaultFeeAmountCents ?? null,
        defaultBudgetHours: e.defaultBudgetHours != null ? String(e.defaultBudgetHours) : null,
        namePattern: e.namePattern ?? null,
        clonedFromSlug: e.slug,
        clonedFromPackVersion: TEMPLATES_PACK_VERSION,
      })
      .returning({ id: engagementTemplates.id });
    idBySlug.set(e.slug, row!.id);
    imported++;
  }
  return { imported, skipped, total: wanted.length, idBySlug };
}

// ---------------------------------------------------------------------------
// Engagement letter templates → engagement_letter_template.
// ---------------------------------------------------------------------------

export async function importLetters(
  db: Database,
  args: { firmId: string; appUserId: string; slugs?: string[] },
): Promise<ImportCounts> {
  const wanted = args.slugs?.length
    ? SYSTEM_LETTER_TEMPLATES.filter((l) => args.slugs!.includes(l.slug))
    : SYSTEM_LETTER_TEMPLATES;
  let imported = 0;
  let skipped = 0;
  if (wanted.length === 0) return { imported, skipped, total: 0 };

  const existing = new Set(
    (
      await db
        .select({ slug: engagementLetterTemplates.clonedFromSlug })
        .from(engagementLetterTemplates)
        .where(
          and(
            eq(engagementLetterTemplates.firmId, args.firmId),
            inArray(
              engagementLetterTemplates.clonedFromSlug,
              wanted.map((l) => l.slug),
            ),
          ),
        )
    )
      .map((r) => r.slug)
      .filter((s): s is string => Boolean(s)),
  );

  for (const l of wanted) {
    if (existing.has(l.slug)) {
      skipped++;
      continue;
    }
    await db.insert(engagementLetterTemplates).values({
      firmId: args.firmId,
      key: l.slug,
      name: l.name,
      bodyHtml: l.bodyHtml,
      clonedFromSlug: l.slug,
      clonedFromPackVersion: TEMPLATES_PACK_VERSION,
    });
    imported++;
  }
  return { imported, skipped, total: wanted.length };
}

// ---------------------------------------------------------------------------
// Request templates → request_template (+ request_template_item).
// ---------------------------------------------------------------------------

export async function importRequests(
  db: Database,
  args: { firmId: string; appUserId: string; slugs?: string[] },
): Promise<ImportCounts> {
  const wanted = args.slugs?.length
    ? SYSTEM_REQUEST_TEMPLATES.filter((r) => args.slugs!.includes(r.slug))
    : SYSTEM_REQUEST_TEMPLATES;
  let imported = 0;
  let skipped = 0;
  if (wanted.length === 0) return { imported, skipped, total: 0 };

  const existing = new Set(
    (
      await db
        .select({ slug: requestTemplates.clonedFromSlug })
        .from(requestTemplates)
        .where(
          and(
            eq(requestTemplates.firmId, args.firmId),
            inArray(
              requestTemplates.clonedFromSlug,
              wanted.map((r) => r.slug),
            ),
          ),
        )
    )
      .map((r) => r.slug)
      .filter((s): s is string => Boolean(s)),
  );

  for (const r of wanted) {
    if (existing.has(r.slug)) {
      skipped++;
      continue;
    }
    const [tpl] = await db
      .insert(requestTemplates)
      .values({
        firmId: args.firmId,
        key: r.slug,
        name: r.name,
        titlePattern: r.titlePattern,
        bodyPattern: r.bodyPattern,
        defaultPriority: r.defaultPriority,
        defaultDueOffsetDays: r.defaultDueOffsetDays ?? null,
        clonedFromSlug: r.slug,
        clonedFromPackVersion: TEMPLATES_PACK_VERSION,
        createdById: args.appUserId,
      })
      .returning({ id: requestTemplates.id });
    let ordinal = 0;
    for (const item of r.items) {
      await db.insert(requestTemplateItems).values({
        templateId: tpl!.id,
        ordinal: ordinal++,
        label: item.label,
        body: item.body ?? '',
        itemKind: item.itemKind,
        required: item.required,
      });
    }
    imported++;
  }
  return { imported, skipped, total: wanted.length };
}

// ---------------------------------------------------------------------------
// Client templates → client_template. Resolves suggested engagement slugs to
// firm engagement-template ids (importing those engagements as needed).
// ---------------------------------------------------------------------------

export async function importClients(
  db: Database,
  args: { firmId: string; appUserId: string; slugs?: string[] },
): Promise<ImportCounts> {
  const wanted = args.slugs?.length
    ? SYSTEM_CLIENT_TEMPLATES.filter((c) => args.slugs!.includes(c.slug))
    : SYSTEM_CLIENT_TEMPLATES;
  let imported = 0;
  let skipped = 0;
  if (wanted.length === 0) return { imported, skipped, total: 0 };

  // Ensure referenced engagement templates exist, and map slug → firm id.
  const engagementSlugs = Array.from(
    new Set(wanted.flatMap((c) => c.defaultEngagementSlugs ?? [])),
  );
  const eng = await importEngagements(db, { ...args, slugs: engagementSlugs });
  const engIdBySlug = eng.idBySlug;

  const existing = new Set(
    (
      await db
        .select({ slug: clientTemplates.clonedFromSlug })
        .from(clientTemplates)
        .where(
          and(
            eq(clientTemplates.firmId, args.firmId),
            inArray(
              clientTemplates.clonedFromSlug,
              wanted.map((c) => c.slug),
            ),
          ),
        )
    )
      .map((r) => r.slug)
      .filter((s): s is string => Boolean(s)),
  );

  for (const c of wanted) {
    if (existing.has(c.slug)) {
      skipped++;
      continue;
    }
    const engagementIds = (c.defaultEngagementSlugs ?? [])
      .map((s) => engIdBySlug.get(s))
      .filter((id): id is string => Boolean(id));
    await db.insert(clientTemplates).values({
      firmId: args.firmId,
      key: c.slug,
      name: c.name,
      clientType: c.clientType,
      defaultsJson: c.defaultsJson ?? {},
      defaultEngagementTemplateIds: engagementIds,
      clonedFromSlug: c.slug,
      clonedFromPackVersion: TEMPLATES_PACK_VERSION,
    });
    imported++;
  }
  return { imported, skipped, total: wanted.length };
}

// ---------------------------------------------------------------------------
// Listing — shipped items annotated with whether they're already imported.
// ---------------------------------------------------------------------------

export interface LibraryItem {
  slug: string;
  name: string;
  category?: string;
  kind?: string;
  imported: boolean;
}

export async function listLibrary(
  db: Database,
  firmId: string,
  area: Area,
): Promise<LibraryItem[]> {
  if (area === 'services') {
    const have = new Set(
      (
        await db
          .select({ slug: servicesCatalog.clonedFromSlug })
          .from(servicesCatalog)
          .where(eq(servicesCatalog.firmId, firmId))
      )
        .map((r) => r.slug)
        .filter((s): s is string => Boolean(s)),
    );
    return SYSTEM_SERVICE_TEMPLATES.map((s) => ({
      slug: s.slug,
      name: s.name,
      category: s.category,
      imported: have.has(s.slug),
    }));
  }
  if (area === 'terms') {
    const have = new Set(
      (
        await db
          .select({ slug: termsTemplates.clonedFromSlug })
          .from(termsTemplates)
          .where(eq(termsTemplates.firmId, firmId))
      )
        .map((r) => r.slug)
        .filter((s): s is string => Boolean(s)),
    );
    return SYSTEM_TERMS_TEMPLATES.map((t) => ({
      slug: t.slug,
      name: t.name,
      category: t.primaryCategory,
      imported: have.has(t.slug),
    }));
  }
  if (area === 'packages') {
    // A package counts as imported when any of its tiers exist.
    const rows = await db
      .select({ slug: packages.clonedFromSlug })
      .from(packages)
      .where(and(eq(packages.firmId, firmId), like(packages.clonedFromSlug, '%:%')));
    const havePrefix = new Set(
      rows.map((r) => r.slug?.split(':')[0]).filter((s): s is string => Boolean(s)),
    );
    return SYSTEM_PACKAGE_TEMPLATES.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.primaryCategory,
      imported: havePrefix.has(p.slug),
    }));
  }
  if (area === 'engagements') {
    const have = new Set(
      (
        await db
          .select({ slug: engagementTemplates.clonedFromSlug })
          .from(engagementTemplates)
          .where(eq(engagementTemplates.firmId, firmId))
      )
        .map((r) => r.slug)
        .filter((s): s is string => Boolean(s)),
    );
    return SYSTEM_ENGAGEMENT_TEMPLATES.map((e) => ({
      slug: e.slug,
      name: e.name,
      category: e.defaultFeeStructure,
      imported: have.has(e.slug),
    }));
  }
  if (area === 'letters') {
    const have = new Set(
      (
        await db
          .select({ slug: engagementLetterTemplates.clonedFromSlug })
          .from(engagementLetterTemplates)
          .where(eq(engagementLetterTemplates.firmId, firmId))
      )
        .map((r) => r.slug)
        .filter((s): s is string => Boolean(s)),
    );
    return SYSTEM_LETTER_TEMPLATES.map((l) => ({
      slug: l.slug,
      name: l.name,
      imported: have.has(l.slug),
    }));
  }
  if (area === 'requests') {
    const have = new Set(
      (
        await db
          .select({ slug: requestTemplates.clonedFromSlug })
          .from(requestTemplates)
          .where(eq(requestTemplates.firmId, firmId))
      )
        .map((r) => r.slug)
        .filter((s): s is string => Boolean(s)),
    );
    return SYSTEM_REQUEST_TEMPLATES.map((r) => ({
      slug: r.slug,
      name: r.name,
      category: r.defaultPriority,
      imported: have.has(r.slug),
    }));
  }
  if (area === 'clients') {
    const have = new Set(
      (
        await db
          .select({ slug: clientTemplates.clonedFromSlug })
          .from(clientTemplates)
          .where(eq(clientTemplates.firmId, firmId))
      )
        .map((r) => r.slug)
        .filter((s): s is string => Boolean(s)),
    );
    return SYSTEM_CLIENT_TEMPLATES.map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.clientType,
      imported: have.has(c.slug),
    }));
  }
  // emails
  const have = new Set(
    (
      await db
        .select({ kind: notificationTemplates.kind })
        .from(notificationTemplates)
        .where(
          and(eq(notificationTemplates.firmId, firmId), eq(notificationTemplates.channel, 'EMAIL')),
        )
    ).map((r) => r.kind),
  );
  return SYSTEM_EMAIL_TEMPLATES.map((e) => ({
    slug: e.slug,
    name: e.subject,
    kind: e.kind,
    imported: have.has(e.kind),
  }));
}
