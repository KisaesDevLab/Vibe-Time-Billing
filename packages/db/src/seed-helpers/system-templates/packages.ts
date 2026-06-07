import type { PackageTemplate } from './types';

/**
 * System package templates.
 *
 * Six starter package skeletons covering the most common CPA service
 * structures. Each uses generic tier names (firms rename on clone),
 * industry-standard line items, and a clear differentiation pattern
 * by service level and access — not by stacking more deliverables.
 *
 * Naming convention guide for tiers:
 *  - 2-tier (Duo):    Core / Plus
 *  - 3-tier (Tiered): Foundation / Standard / Premier
 *
 * Firms can rename to Bronze/Silver/Gold, Essentials/Standard/Premium,
 * or any other convention when they clone.
 */

export const SYSTEM_PACKAGE_TEMPLATES: PackageTemplate[] = [
  // ==========================================================================
  // 1. Individual Tax — 2-Tier (Duo)
  // ==========================================================================
  {
    slug: 'individual-tax-duo',
    name: 'Individual Tax — Two-Tier Starter',
    primaryCategory: 'TAX',
    descriptionMd:
      'Two-column starter package for individual (1040) tax preparation. Same return, two different experience levels. A good entry point for firms moving off hourly or single-flat-rate pricing.',
    format: 'duo',
    nicheTag: null,
    tiers: [
      {
        slug: 'core',
        name: 'Core',
        tagline: 'Compliance handled accurately and on time.',
        position: 1,
      },
      {
        slug: 'plus',
        name: 'Plus',
        tagline: 'Compliance plus year-round support.',
        position: 2,
      },
    ],
    items: [
      // Core Deliverables
      {
        position: 10,
        section: 'core_deliverables',
        itemType: 'service',
        label: 'Federal 1040 preparation and filing',
        serviceSlug: 'individual-1040',
        tierValues: { core: '✓', plus: '✓' },
      },
      {
        position: 20,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'State return (one state)',
        tierValues: { core: '✓', plus: '✓' },
      },
      {
        position: 30,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Standard schedules (A, B, D, E as applicable)',
        tierValues: { core: '✓', plus: '✓' },
      },
      {
        position: 40,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Secure client portal access',
        tierValues: { core: '✓', plus: '✓' },
      },
      {
        position: 50,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Digital copy of filed return',
        tierValues: { core: '✓', plus: '✓' },
      },
      // Service Levels
      {
        position: 100,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Turnaround time after documents received',
        tierValues: { core: 'Standard cadence', plus: 'Priority cadence' },
      },
      {
        position: 110,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Response time for questions',
        tierValues: {
          core: 'Within 5 business days',
          plus: 'Within 2 business days',
        },
      },
      {
        position: 120,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Communication channel',
        tierValues: { core: 'Email and portal', plus: 'Email, portal, phone' },
      },
      // Support & Access
      {
        position: 200,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Estimated tax payment reminders',
        tierValues: { core: '—', plus: '✓' },
      },
      {
        position: 210,
        section: 'support_and_access',
        itemType: 'service',
        label: 'IRS or state notice review and response',
        serviceSlug: 'irs-notice-response',
        tierValues: { core: 'Billed separately', plus: 'Included' },
      },
      {
        position: 220,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Mid-year planning check-in',
        tierValues: { core: '—', plus: '✓' },
      },
      // Optional Add-Ons
      {
        position: 300,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Additional state filings',
        serviceSlug: 'multi-state-addon',
        tierValues: { core: 'Add-on', plus: 'Add-on' },
      },
      {
        position: 310,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Tax extension preparation',
        serviceSlug: 'tax-extension',
        tierValues: { core: 'Add-on', plus: 'Included' },
      },
    ],
    tags: ['individual', '1040', 'duo', 'starter'],
    importNotes:
      "Set Core at the price you would charge for compliance only. Plus typically prices 30–60% higher than Core. Edit the line items to match your firm's actual offerings before sending to a client.",
  },

  // ==========================================================================
  // 2. Individual Tax — 3-Tier
  // ==========================================================================
  {
    slug: 'individual-tax-tiered',
    name: 'Individual Tax — Three-Tier',
    primaryCategory: 'TAX',
    descriptionMd:
      'Three-column package for 1040 preparation with clear anchoring between essential compliance, supported service, and year-round partnership. Use this when you want clients to self-select into the level of access they want.',
    format: 'tiered',
    nicheTag: null,
    tiers: [
      {
        slug: 'foundation',
        name: 'Foundation',
        tagline: 'Accurate compliance at a clear price.',
        position: 1,
      },
      {
        slug: 'standard',
        name: 'Standard',
        tagline: 'Compliance plus the support you actually use.',
        position: 2,
      },
      {
        slug: 'premier',
        name: 'Premier',
        tagline: 'Year-round access, priority handling, proactive planning.',
        position: 3,
      },
    ],
    items: [
      // Core Deliverables
      {
        position: 10,
        section: 'core_deliverables',
        itemType: 'service',
        label: 'Federal 1040 preparation and filing',
        serviceSlug: 'individual-1040',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      {
        position: 20,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'State return(s)',
        tierValues: {
          foundation: 'One state',
          standard: 'One state',
          premier: 'All required',
        },
      },
      {
        position: 30,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Standard schedules (A, B, D, E as applicable)',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      {
        position: 40,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Secure portal and digital filed copy',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      // Service Levels
      {
        position: 100,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Turnaround time after documents received',
        tierValues: {
          foundation: 'Standard',
          standard: 'Faster',
          premier: 'Priority',
        },
      },
      {
        position: 110,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Response time for questions',
        tierValues: {
          foundation: 'Within 5 business days',
          standard: 'Within 2 business days',
          premier: 'Same business day',
        },
      },
      {
        position: 120,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Communication channel',
        tierValues: {
          foundation: 'Email and portal',
          standard: 'Email, portal, scheduled calls',
          premier: 'Direct access including phone',
        },
      },
      {
        position: 130,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Extension handling',
        tierValues: {
          foundation: 'Firm discretion (fee applies)',
          standard: 'Client discretion (fee applies)',
          premier: 'Client discretion (included)',
        },
      },
      // Support & Access
      {
        position: 200,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Return walkthrough',
        tierValues: {
          foundation: '—',
          standard: 'Video walkthrough',
          premier: 'Live review meeting',
        },
      },
      {
        position: 210,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Estimated tax payment reminders',
        tierValues: { foundation: '—', standard: '✓', premier: '✓' },
      },
      {
        position: 220,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Estimated tax calculation basis',
        tierValues: {
          foundation: '—',
          standard: 'Safe-harbor (prior year)',
          premier: 'Current-year projection',
        },
      },
      {
        position: 230,
        section: 'support_and_access',
        itemType: 'service',
        label: 'IRS or state notice review and response',
        serviceSlug: 'irs-notice-response',
        tierValues: {
          foundation: 'Billed separately',
          standard: 'Review only',
          premier: 'Review and response included',
        },
      },
      {
        position: 240,
        section: 'support_and_access',
        itemType: 'service',
        label: 'Tax planning session',
        serviceSlug: 'tax-planning-session',
        tierValues: {
          foundation: 'Add-on',
          standard: 'One per year',
          premier: 'Multiple per year as needed',
        },
      },
      {
        position: 250,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Guaranteed engagement slot next year',
        tierValues: { foundation: '—', standard: '—', premier: '✓' },
      },
      // Optional Add-Ons
      {
        position: 300,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Additional state filings',
        serviceSlug: 'multi-state-addon',
        tierValues: {
          foundation: 'Add-on',
          standard: 'Add-on',
          premier: 'Included',
        },
      },
      {
        position: 310,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Amended return preparation',
        serviceSlug: 'amended-return',
        tierValues: {
          foundation: 'Add-on',
          standard: 'Add-on',
          premier: 'Add-on at discounted rate',
        },
      },
    ],
    tags: ['individual', '1040', 'tiered', 'three-tier'],
    importNotes:
      'A common pattern is to set Foundation 10–15% above your current flat rate, Standard 30–50% above, and Premier roughly double. Adjust based on the level of service you actually provide your top clients today.',
  },

  // ==========================================================================
  // 3. Business Tax — 3-Tier
  // ==========================================================================
  {
    slug: 'business-tax-tiered',
    name: 'Business Tax — Three-Tier',
    primaryCategory: 'TAX',
    descriptionMd:
      'Three-column package for business tax returns (1120-S, 1065, 1120). Works for solo owners and partnerships with one to a few owners. For multi-entity or holding-company structures, scope as a separate engagement.',
    format: 'tiered',
    nicheTag: null,
    tiers: [
      {
        slug: 'foundation',
        name: 'Foundation',
        tagline: 'Return filed correctly, year after year.',
        position: 1,
      },
      {
        slug: 'standard',
        name: 'Standard',
        tagline: 'Return filed plus coordinated planning.',
        position: 2,
      },
      {
        slug: 'premier',
        name: 'Premier',
        tagline: 'Full coordination of business and owner returns.',
        position: 3,
      },
    ],
    items: [
      // Core Deliverables
      {
        position: 10,
        section: 'core_deliverables',
        itemType: 'service',
        label: 'Federal business return (1120-S / 1065 / 1120)',
        serviceSlug: 'business-tax-1120s',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      {
        position: 20,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'State business return(s)',
        tierValues: {
          foundation: 'One state',
          standard: 'All required states',
          premier: 'All required states',
        },
      },
      {
        position: 30,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'K-1 preparation and delivery',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      {
        position: 40,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Owner basis and capital account tracking',
        tierValues: {
          foundation: 'Basic',
          standard: 'Full tracking',
          premier: 'Full tracking with year-over-year reconciliation',
        },
      },
      {
        position: 50,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Book-to-tax adjustment review',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      // Service Levels
      {
        position: 100,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Turnaround time after documents received',
        tierValues: {
          foundation: 'Standard',
          standard: 'Faster',
          premier: 'Priority',
        },
      },
      {
        position: 110,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Response time for questions',
        tierValues: {
          foundation: 'Within 5 business days',
          standard: 'Within 2 business days',
          premier: 'Same business day',
        },
      },
      {
        position: 120,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Extension handling',
        tierValues: {
          foundation: 'Firm discretion (fee applies)',
          standard: 'Client discretion (included)',
          premier: 'Client discretion (included)',
        },
      },
      // Support & Access
      {
        position: 200,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Coordination with owner personal return',
        tierValues: {
          foundation: '—',
          standard: 'Light coordination',
          premier: 'Full coordination, single point of contact',
        },
      },
      {
        position: 210,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Estimated tax projections for owners',
        tierValues: {
          foundation: '—',
          standard: 'Safe-harbor (prior year)',
          premier: 'Current-year projection',
        },
      },
      {
        position: 220,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Year-end review meeting',
        tierValues: {
          foundation: '—',
          standard: 'One meeting',
          premier: 'Quarterly check-ins',
        },
      },
      {
        position: 230,
        section: 'support_and_access',
        itemType: 'service',
        label: 'IRS or state notice review and response',
        serviceSlug: 'irs-notice-response',
        tierValues: {
          foundation: 'Billed separately',
          standard: 'Review only',
          premier: 'Review and response included',
        },
      },
      // Optional Add-Ons
      {
        position: 300,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Owner individual 1040 preparation',
        serviceSlug: 'individual-1040',
        tierValues: {
          foundation: 'Add-on',
          standard: 'Add-on at package rate',
          premier: 'Add-on at package rate',
        },
      },
      {
        position: 310,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Sales and use tax filings',
        serviceSlug: 'sales-tax-filing',
        tierValues: {
          foundation: 'Add-on',
          standard: 'Add-on',
          premier: 'Add-on',
        },
      },
      {
        position: 320,
        section: 'optional_addons',
        itemType: 'service',
        label: '1099 preparation',
        serviceSlug: 'year-end-1099',
        tierValues: {
          foundation: 'Add-on',
          standard: 'Add-on',
          premier: 'Included',
        },
      },
    ],
    tags: ['business', '1120-s', '1065', '1120', 'tiered'],
    importNotes:
      'For multi-entity owners (holdco + opcos, or several pass-throughs), consider a fixed-fee per-entity model and add a coordination fee that ties them together.',
  },

  // ==========================================================================
  // 4. Monthly Bookkeeping — 3-Tier
  // ==========================================================================
  {
    slug: 'monthly-bookkeeping-tiered',
    name: 'Monthly Bookkeeping — Three-Tier',
    primaryCategory: 'BOOKKEEPING',
    descriptionMd:
      'Three-column monthly bookkeeping package. Differentiates tiers primarily by cadence of close, depth of explanation, and access — not by stacking more deliverables.',
    format: 'tiered',
    nicheTag: null,
    tiers: [
      {
        slug: 'foundation',
        name: 'Foundation',
        tagline: 'Clean books, delivered consistently.',
        position: 1,
      },
      {
        slug: 'standard',
        name: 'Standard',
        tagline: 'Clean books plus the context to use them.',
        position: 2,
      },
      {
        slug: 'premier',
        name: 'Premier',
        tagline: 'Books, context, and a partner in your numbers.',
        position: 3,
      },
    ],
    items: [
      // Core Deliverables
      {
        position: 10,
        section: 'core_deliverables',
        itemType: 'service',
        label: 'Transaction coding',
        serviceSlug: 'monthly-bookkeeping-low-volume',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      {
        position: 20,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Bank and credit card reconciliation',
        tierValues: {
          foundation: 'Monthly',
          standard: 'Monthly',
          premier: 'Weekly during the month, final at month-end',
        },
      },
      {
        position: 30,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'General ledger maintenance',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      {
        position: 40,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Monthly financial statements',
        tierValues: {
          foundation: 'Standard P&L and balance sheet',
          standard: 'P&L, balance sheet, cash flow',
          premier: 'P&L, balance sheet, cash flow, with comparatives',
        },
      },
      {
        position: 50,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Secure client portal access',
        tierValues: { foundation: '✓', standard: '✓', premier: '✓' },
      },
      // Service Levels
      {
        position: 100,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Close cadence — books delivered by',
        tierValues: {
          foundation: 'End of following month',
          standard: 'By the 20th of following month',
          premier: 'By the 10th of following month',
        },
      },
      {
        position: 110,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Response time for questions',
        tierValues: {
          foundation: 'Within 5 business days',
          standard: 'Within 2 business days',
          premier: 'Same business day',
        },
      },
      {
        position: 120,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Communication channel',
        tierValues: {
          foundation: 'Email and portal',
          standard: 'Email, portal, scheduled calls',
          premier: 'Direct access including phone',
        },
      },
      {
        position: 130,
        section: 'service_levels',
        itemType: 'experience',
        label: 'In-month cleanup of minor issues',
        tierValues: {
          foundation: 'Resolved at next close',
          standard: 'Resolved within the month',
          premier: 'Resolved within the week',
        },
      },
      // Support & Access
      {
        position: 200,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Plain-English explanation of monthly results',
        tierValues: {
          foundation: '—',
          standard: 'Written summary with statements',
          premier: 'Written summary plus live review meeting',
        },
      },
      {
        position: 210,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Business review meeting cadence',
        tierValues: {
          foundation: 'Annual',
          standard: 'Quarterly',
          premier: 'Monthly',
        },
      },
      {
        position: 220,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Coordination with tax preparer',
        tierValues: {
          foundation: 'Year-end handoff only',
          standard: 'Quarterly check-in',
          premier: 'Ongoing throughout the year',
        },
      },
      {
        position: 230,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Ad-hoc questions',
        tierValues: {
          foundation: 'Billed separately',
          standard: 'Limited (3 per year)',
          premier: 'Unlimited within reason',
        },
      },
      // Optional Add-Ons
      {
        position: 300,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Sales and use tax filings',
        serviceSlug: 'sales-tax-filing',
        tierValues: {
          foundation: 'Add-on',
          standard: 'Add-on',
          premier: 'Add-on',
        },
      },
      {
        position: 310,
        section: 'optional_addons',
        itemType: 'service',
        label: '1099 preparation',
        serviceSlug: 'year-end-1099',
        tierValues: {
          foundation: 'Add-on',
          standard: 'Add-on',
          premier: 'Included',
        },
      },
      {
        position: 320,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Catch-up / cleanup project',
        serviceSlug: 'catch-up-bookkeeping',
        tierValues: {
          foundation: 'Separate engagement',
          standard: 'Separate engagement',
          premier: 'Separate engagement',
        },
      },
    ],
    tags: ['bookkeeping', 'monthly', 'recurring', 'tiered'],
    importNotes:
      'Cleanup work should always be a separate fixed-fee engagement, never folded into a monthly subscription. The "Separate engagement" row reminds the client of that boundary up front.',
  },

  // ==========================================================================
  // 5. Advisory & Fractional CFO — 3-Tier
  // ==========================================================================
  {
    slug: 'advisory-cfo-tiered',
    name: 'Advisory & Fractional CFO — Three-Tier',
    primaryCategory: 'CFO',
    descriptionMd:
      'Three-column package for outsourced controller and CFO services. Tiers differentiate by depth of involvement and strategic influence, not by quantity of deliverables.',
    format: 'tiered',
    nicheTag: null,
    tiers: [
      {
        slug: 'oversight',
        name: 'Oversight',
        tagline: 'Controller-level review and discipline.',
        position: 1,
      },
      {
        slug: 'analytical',
        name: 'Analytical',
        tagline: 'Oversight plus insight and planning.',
        position: 2,
      },
      {
        slug: 'embedded',
        name: 'Embedded',
        tagline: 'Embedded financial leadership at the table.',
        position: 3,
      },
    ],
    items: [
      // Core Deliverables
      {
        position: 10,
        section: 'core_deliverables',
        itemType: 'service',
        label: 'Monthly close oversight',
        serviceSlug: 'fractional-controller',
        tierValues: { oversight: '✓', analytical: '✓', embedded: '✓' },
      },
      {
        position: 20,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Monthly management reporting package',
        tierValues: {
          oversight: 'Standard P&L and balance sheet',
          analytical: 'Reporting package with KPIs and variance commentary',
          embedded: 'Custom reporting package, board-ready',
        },
      },
      {
        position: 30,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Coordination with bookkeeping team',
        tierValues: { oversight: '✓', analytical: '✓', embedded: '✓' },
      },
      // Service Levels
      {
        position: 100,
        section: 'service_levels',
        itemType: 'service',
        label: 'KPI dashboard and reporting',
        serviceSlug: 'kpi-reporting-monthly',
        tierValues: {
          oversight: '—',
          analytical: 'Monthly',
          embedded: 'Monthly with monthly review meeting',
        },
      },
      {
        position: 110,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Variance analysis vs budget',
        tierValues: {
          oversight: '—',
          analytical: 'Monthly',
          embedded: 'Monthly with cause-and-action commentary',
        },
      },
      {
        position: 120,
        section: 'service_levels',
        itemType: 'service',
        label: 'Cash flow forecasting',
        serviceSlug: 'cash-flow-forecast-13-week',
        tierValues: {
          oversight: '—',
          analytical: 'Quarterly rolling',
          embedded: '13-week rolling, updated weekly',
        },
      },
      {
        position: 130,
        section: 'service_levels',
        itemType: 'service',
        label: 'Annual budget preparation',
        serviceSlug: 'annual-budget-preparation',
        tierValues: {
          oversight: 'Add-on',
          analytical: 'Included',
          embedded: 'Included with quarterly reforecast',
        },
      },
      // Support & Access
      {
        position: 200,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Leadership review meeting cadence',
        tierValues: {
          oversight: 'Quarterly',
          analytical: 'Monthly',
          embedded: 'Monthly plus mid-month check-in',
        },
      },
      {
        position: 210,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Response time for leadership questions',
        tierValues: {
          oversight: 'Within 3 business days',
          analytical: 'Within 1 business day',
          embedded: 'Same business day',
        },
      },
      {
        position: 220,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Communication channel',
        tierValues: {
          oversight: 'Email and scheduled calls',
          analytical: 'Email, calendar, and direct phone',
          embedded: 'Direct phone and text as needed',
        },
      },
      {
        position: 230,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Board or investor reporting support',
        tierValues: {
          oversight: '—',
          analytical: 'Materials preparation',
          embedded: 'Materials preparation plus meeting attendance',
        },
      },
      {
        position: 240,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Ad-hoc analysis and scenario modeling',
        tierValues: {
          oversight: 'Billed separately',
          analytical: 'Up to 4 hours per month included',
          embedded: 'Up to 10 hours per month included',
        },
      },
      // Optional Add-Ons
      {
        position: 300,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Fundraising financial preparation',
        serviceSlug: 'fundraising-financial-prep',
        tierValues: {
          oversight: 'Separate engagement',
          analytical: 'Separate engagement',
          embedded: 'Separate engagement at preferred rate',
        },
      },
      {
        position: 310,
        section: 'optional_addons',
        itemType: 'service',
        label: 'M&A advisory (buy- or sell-side)',
        serviceSlug: 'ma-buy-side-advisory',
        tierValues: {
          oversight: 'Separate engagement',
          analytical: 'Separate engagement',
          embedded: 'Separate engagement at preferred rate',
        },
      },
    ],
    tags: ['cfo', 'controller', 'advisory', 'tiered'],
    importNotes:
      'CFO and controller pricing is often best scaled to client revenue. Consider building a revenue-banded version of this package (e.g., under $1M, $1M–$5M, $5M–$25M) with different prices per band.',
  },

  // ==========================================================================
  // 6. Fiduciary / Trust Returns — 3-Tier
  // ==========================================================================
  {
    slug: 'fiduciary-trust-tiered',
    name: 'Fiduciary & Trust Returns — Three-Tier',
    primaryCategory: 'TAX',
    descriptionMd:
      'Three-column package for Form 1041 fiduciary returns. Tier names lean descriptive rather than aspirational to fit the emotional weight of trust and estate work.',
    format: 'tiered',
    nicheTag: 'fiduciary',
    tiers: [
      {
        slug: 'preparation',
        name: 'Preparation',
        tagline: 'Fiduciary return prepared correctly by a specialist.',
        position: 1,
      },
      {
        slug: 'guided',
        name: 'Guided',
        tagline: 'Preparation plus context for trustees and beneficiaries.',
        position: 2,
      },
      {
        slug: 'comprehensive',
        name: 'Comprehensive',
        tagline: 'Year-round coordination, optimization, and priority access.',
        position: 3,
      },
    ],
    items: [
      // Core Deliverables
      {
        position: 10,
        section: 'core_deliverables',
        itemType: 'service',
        label: 'Federal fiduciary return (Form 1041)',
        serviceSlug: 'fiduciary-1041',
        tierValues: {
          preparation: '✓',
          guided: '✓',
          comprehensive: '✓',
        },
      },
      {
        position: 20,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'State fiduciary return(s)',
        tierValues: {
          preparation: 'As required',
          guided: 'All required',
          comprehensive: 'All required',
        },
      },
      {
        position: 30,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Income allocation and K-1 issuance to beneficiaries',
        tierValues: {
          preparation: '✓',
          guided: '✓',
          comprehensive: '✓',
        },
      },
      {
        position: 40,
        section: 'core_deliverables',
        itemType: 'experience',
        label: 'Digital copy of filed return',
        tierValues: {
          preparation: '✓',
          guided: '✓',
          comprehensive: '✓',
        },
      },
      // Service Levels
      {
        position: 100,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Turnaround time after documents received',
        tierValues: {
          preparation: 'Standard',
          guided: 'Faster',
          comprehensive: 'Priority',
        },
      },
      {
        position: 110,
        section: 'service_levels',
        itemType: 'experience',
        label: 'Extension handling',
        tierValues: {
          preparation: 'Firm discretion',
          guided: 'Client discretion',
          comprehensive: 'Client discretion',
        },
      },
      // Support & Access
      {
        position: 200,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Plain-English trust activity summary',
        tierValues: {
          preparation: '✓',
          guided: '✓',
          comprehensive: '✓',
        },
      },
      {
        position: 210,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Trust terms walkthrough for trustee',
        tierValues: {
          preparation: '—',
          guided: '✓',
          comprehensive: '✓',
        },
      },
      {
        position: 220,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Coordination with trustee, executor, and attorney',
        tierValues: {
          preparation: '—',
          guided: '✓',
          comprehensive: '✓',
        },
      },
      {
        position: 230,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Beneficiary communication support',
        tierValues: {
          preparation: '—',
          guided: 'Limited',
          comprehensive: 'Included',
        },
      },
      {
        position: 240,
        section: 'support_and_access',
        itemType: 'experience',
        label: 'Projected tax consequences of distributions',
        tierValues: {
          preparation: '—',
          guided: '—',
          comprehensive: '✓',
        },
      },
      {
        position: 250,
        section: 'support_and_access',
        itemType: 'experience',
        label: '65-day rule optimization analysis',
        tierValues: {
          preparation: '—',
          guided: '—',
          comprehensive: '✓',
        },
      },
      {
        position: 260,
        section: 'support_and_access',
        itemType: 'service',
        label: 'IRS or state notice review and response',
        serviceSlug: 'irs-notice-response',
        tierValues: {
          preparation: 'Billed separately',
          guided: 'Review only',
          comprehensive: 'Review and response included',
        },
      },
      // Optional Add-Ons
      {
        position: 300,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Estate tax return (Form 706)',
        serviceSlug: 'estate-706',
        tierValues: {
          preparation: 'Separate engagement',
          guided: 'Separate engagement',
          comprehensive: 'Separate engagement',
        },
      },
      {
        position: 310,
        section: 'optional_addons',
        itemType: 'service',
        label: 'Gift tax return (Form 709)',
        serviceSlug: 'gift-709',
        tierValues: {
          preparation: 'Add-on',
          guided: 'Add-on',
          comprehensive: 'Add-on at preferred rate',
        },
      },
    ],
    tags: ['fiduciary', 'trust', '1041', 'tiered'],
    importNotes:
      'Fiduciary clients are often navigating a difficult time. Tier names should signal care and stability rather than ambition. Engagement-letter scope language should be unusually clear about what is and is not included to avoid expectations gaps during stressful periods.',
  },
];

/**
 * Convenience: get packages applicable to a given primary category.
 */
export function packagesByPrimaryCategory(category: string) {
  return SYSTEM_PACKAGE_TEMPLATES.filter((p) => p.primaryCategory === category);
}
