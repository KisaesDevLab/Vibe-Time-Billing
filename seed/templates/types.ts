/**
 * Vibe Time & Billing — System Template Library Types
 *
 * These types describe the shape of system-shipped starter templates
 * that ship with the appliance. They are read-only library content;
 * firms clone them into their own editable catalog tables.
 */

// ----------------------------------------------------------------------------
// Categories — the 6 hard-coded service categories from build plan P01
// ----------------------------------------------------------------------------

export const SERVICE_CATEGORIES = [
  'TAX',
  'BOOKKEEPING',
  'AUDIT',
  'ADVISORY',
  'PAYROLL',
  'CFO',
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface ServiceCategoryDefinition {
  slug: ServiceCategory;
  displayName: string;
  shortDescription: string;
  defaultCoaCode: string; // e.g., "4100"
  defaultCoaLabel: string; // e.g., "Tax Service Revenue"
  iconHint: string; // Lucide icon name suggestion
  position: number;
}

// ----------------------------------------------------------------------------
// Billing types — matches build plan P01 ENUMs
// ----------------------------------------------------------------------------

export type BillingType =
  | 'on_acceptance' // one-time, billed when proposal accepted
  | 'on_completion' // milestone, billed when deliverable complete
  | 'recurring' // subscription
  | 'variable' // T&M, billed periodically from time entries
  | 'hourly'; // T&M, billed per hour

export type RecurringInterval = 'weekly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual';

// ----------------------------------------------------------------------------
// Service templates
// ----------------------------------------------------------------------------

export interface ServiceTemplate {
  /** Stable kebab-case identifier; never change after shipping. */
  slug: string;
  category: ServiceCategory;
  name: string;
  /** Markdown. Keep concise; the firm will edit when they clone. */
  descriptionMd: string;
  billingType: BillingType;
  recurringInterval?: RecurringInterval;
  /** Placeholder price in cents. Firms set their own. */
  defaultPriceCents: number;
  /** Generic industry range for sanity-checking, not a recommendation. */
  suggestedPriceRangeCents: { low: number; high: number };
  /** Add-on services attach to a parent service in a proposal. */
  isAddon: boolean;
  /** Free-form tags for firm-side filtering. */
  tags: string[];
  /** Optional notes shown to the firm when they import. */
  importNotes?: string;
}

// ----------------------------------------------------------------------------
// Package templates
// ----------------------------------------------------------------------------

export type PackageFormat = 'duo' | 'tiered'; // 2-column or 3-column

export interface PackageTier {
  /** Slug within the package, stable. */
  slug: string;
  /** "Bronze" / "Core" / "Foundation" — generic, firm can rename on clone. */
  name: string;
  /** Short tagline displayed to clients in the portal. */
  tagline: string;
  position: number;
}

export type LineItemSection =
  | 'core_deliverables'
  | 'service_levels'
  | 'support_and_access'
  | 'optional_addons';

/**
 * A line item in a package template. Two flavors:
 *  - itemType=service: maps to a system service template via serviceSlug.
 *    When the firm clones, the corresponding service is also cloned and the
 *    link is materialized in package_services.
 *  - itemType=experience: is a free-text comparison row (turnaround time,
 *    response time, access). Does NOT create a service record.
 */
export interface PackageTemplateItem {
  position: number;
  section: LineItemSection;
  itemType: 'service' | 'experience';
  /** Label shown in the package table left column. */
  label: string;
  /** Required if itemType === 'service' */
  serviceSlug?: string;
  /**
   * Per-tier value. Keys must match PackageTier.slug.
   * For service items: value is typically "✓" or "—" or a frequency descriptor.
   * For experience items: value is a free-text comparator.
   */
  tierValues: Record<string, string>;
}

export interface PackageTemplate {
  slug: string;
  /** Display name in the firm-side Templates Library browser. */
  name: string;
  /** Which service category this package primarily targets. */
  primaryCategory: ServiceCategory;
  /** Plain-English description of the package's purpose. */
  descriptionMd: string;
  format: PackageFormat;
  /** Industry segment if this is a niche package, else null. */
  nicheTag: string | null;
  tiers: PackageTier[];
  items: PackageTemplateItem[];
  /** Free-form tags for filtering in the Templates Library. */
  tags: string[];
  importNotes: string;
}

// ----------------------------------------------------------------------------
// Engagement letter / terms templates
// ----------------------------------------------------------------------------

export type TermsTemplateSource =
  | 'aicpa_aligned' // built from public AICPA / SSARS / AU-C standards
  | 'industry_generic' // common-practice scaffolding
  | 'custom'; // firm-authored (not used for system templates)

export interface TermsTemplate {
  slug: string;
  name: string;
  /** Which service category this scaffold most fits. */
  primaryCategory: ServiceCategory;
  /**
   * Body in Markdown. Merge tokens use mustache syntax:
   *   {{ firm.legal_name }}, {{ client.legal_name }}, {{ engagement.scope }},
   *   {{ engagement.fee_text }}, {{ today }}.
   * The visual block editor resolves these at send time.
   */
  bodyMd: string;
  source: TermsTemplateSource;
  /**
   * Citations the firm should review before sending — public standards
   * referenced in the scaffold (e.g., "AU-C 210", "SSARS AR-C 70").
   */
  standardsReferenced: string[];
  importNotes: string;
}

// ----------------------------------------------------------------------------
// Email templates
// ----------------------------------------------------------------------------

export type EmailTemplateKind =
  | 'proposal_sent'
  | 'proposal_reminder_view'
  | 'proposal_reminder_sign'
  | 'proposal_accepted'
  | 'proposal_expired'
  | 'engagement_welcome'
  | 'invoice_receipt'
  | 'payment_failed'
  | 'mandate_invalid'
  | 'renewal_upcoming';

export interface EmailTemplate {
  slug: string;
  kind: EmailTemplateKind;
  subject: string;
  /**
   * Markdown body. Same merge-token convention as terms templates.
   * Available tokens depend on `kind` — see emails.ts for the per-kind list.
   */
  bodyMd: string;
  /** Plain-text fallback, optional. If omitted, the renderer strips markdown. */
  plainTextBody?: string;
}

// ----------------------------------------------------------------------------
// Pack metadata (versioning)
// ----------------------------------------------------------------------------

export interface TemplatePackManifest {
  packVersion: string; // semver, e.g., "1.0.0"
  shippedWithApplianceVersion: string;
  generatedAt: string; // ISO 8601
  counts: {
    categories: number;
    services: number;
    packages: number;
    terms: number;
    emails: number;
  };
}
