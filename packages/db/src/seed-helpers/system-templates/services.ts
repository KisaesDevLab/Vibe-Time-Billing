import type { ServiceTemplate } from './types';

/**
 * System service templates.
 *
 * These are starter services that ship with the appliance. They use
 * generic CPA-industry service names and original descriptions. Firms
 * clone any subset they want into their own services_catalog and edit
 * freely from there.
 *
 * Pricing defaults are placeholders — every firm should set their own.
 * The suggestedPriceRangeCents fields are intentionally wide to avoid
 * anchoring any particular pricing philosophy.
 */
export const SYSTEM_SERVICE_TEMPLATES: ServiceTemplate[] = [
  // --------------------------------------------------------------------------
  // TAX
  // --------------------------------------------------------------------------
  {
    slug: 'individual-1040',
    category: 'TAX',
    name: 'Individual Tax Return (Form 1040)',
    descriptionMd:
      "Preparation and filing of the federal individual income tax return, plus one state return. Includes standard schedules as applicable to the client's situation (Schedule A, B, D, E, etc.). Additional state filings and complex schedules are billable add-ons.",
    billingType: 'on_acceptance',
    defaultPriceCents: 75000, // $750
    suggestedPriceRangeCents: { low: 30000, high: 250000 },
    isAddon: false,
    tags: ['1040', 'individual', 'tax'],
    importNotes:
      'Most firms price 1040s by complexity rather than as a single rate. Consider using the 3-tier Individual Tax package template to offer Bronze/Silver/Gold options.',
  },
  {
    slug: 'business-tax-1120s',
    category: 'TAX',
    name: 'S-Corporation Tax Return (Form 1120-S)',
    descriptionMd:
      'Federal S-corporation income tax return with one state. Includes K-1 preparation and delivery to shareholders, basic shareholder basis tracking, and one round of review with the engagement partner.',
    billingType: 'on_acceptance',
    defaultPriceCents: 150000, // $1,500
    suggestedPriceRangeCents: { low: 80000, high: 750000 },
    isAddon: false,
    tags: ['1120-s', 'business', 'tax', 's-corp'],
  },
  {
    slug: 'business-tax-1065',
    category: 'TAX',
    name: 'Partnership Tax Return (Form 1065)',
    descriptionMd:
      'Federal partnership income tax return with one state. Includes K-1 preparation and delivery to partners, and basic partner capital account maintenance.',
    billingType: 'on_acceptance',
    defaultPriceCents: 175000, // $1,750
    suggestedPriceRangeCents: { low: 100000, high: 750000 },
    isAddon: false,
    tags: ['1065', 'business', 'tax', 'partnership'],
  },
  {
    slug: 'business-tax-1120',
    category: 'TAX',
    name: 'C-Corporation Tax Return (Form 1120)',
    descriptionMd:
      'Federal C-corporation income tax return with one state. Includes book-to-tax reconciliation and tax provision support when needed.',
    billingType: 'on_acceptance',
    defaultPriceCents: 200000, // $2,000
    suggestedPriceRangeCents: { low: 100000, high: 1000000 },
    isAddon: false,
    tags: ['1120', 'business', 'tax', 'c-corp'],
  },
  {
    slug: 'fiduciary-1041',
    category: 'TAX',
    name: 'Fiduciary Income Tax Return (Form 1041)',
    descriptionMd:
      'Federal fiduciary income tax return for trusts and estates, with one state. Includes income allocation among beneficiaries and K-1 issuance. Trust accounting and beneficiary statement preparation available as add-ons.',
    billingType: 'on_acceptance',
    defaultPriceCents: 200000, // $2,000
    suggestedPriceRangeCents: { low: 100000, high: 800000 },
    isAddon: false,
    tags: ['1041', 'fiduciary', 'trust', 'estate', 'tax'],
    importNotes:
      'Fiduciary work often involves emotional client situations. Engagement-letter language should set clear scope, communication boundaries, and a defined process for distributions and beneficiary inquiries.',
  },
  {
    slug: 'estate-706',
    category: 'TAX',
    name: 'Estate Tax Return (Form 706)',
    descriptionMd:
      'Federal estate tax return for decedents required to file. Includes asset valuation review, deduction support, and coordination with attorney and executor.',
    billingType: 'on_acceptance',
    defaultPriceCents: 750000, // $7,500
    suggestedPriceRangeCents: { low: 400000, high: 5000000 },
    isAddon: false,
    tags: ['706', 'estate', 'tax'],
  },
  {
    slug: 'gift-709',
    category: 'TAX',
    name: 'Gift Tax Return (Form 709)',
    descriptionMd:
      'Federal gift tax return for taxable gifts made during the year. Includes generation-skipping transfer tax analysis when applicable.',
    billingType: 'on_acceptance',
    defaultPriceCents: 75000, // $750
    suggestedPriceRangeCents: { low: 40000, high: 350000 },
    isAddon: false,
    tags: ['709', 'gift', 'tax'],
  },
  {
    slug: 'exempt-990',
    category: 'TAX',
    name: 'Exempt Organization Return (Form 990)',
    descriptionMd:
      'Annual information return for tax-exempt organizations. Includes governance schedule, compensation analysis, and public-disclosure-ready PDF preparation. Form 990-T (UBI) available as an add-on.',
    billingType: 'on_acceptance',
    defaultPriceCents: 250000, // $2,500
    suggestedPriceRangeCents: { low: 150000, high: 1500000 },
    isAddon: false,
    tags: ['990', 'nonprofit', 'exempt', 'tax'],
  },
  {
    slug: 'amended-return',
    category: 'TAX',
    name: 'Amended Tax Return',
    descriptionMd:
      'Preparation and filing of an amended federal return (Form 1040-X, 1120-X, or 1065-X) and corresponding state amendments. Priced as a project; complex amendments may warrant a separate scope agreement.',
    billingType: 'on_acceptance',
    defaultPriceCents: 100000, // $1,000
    suggestedPriceRangeCents: { low: 50000, high: 500000 },
    isAddon: false,
    tags: ['amended', 'tax'],
  },
  {
    slug: 'multi-state-addon',
    category: 'TAX',
    name: 'Additional State Tax Return',
    descriptionMd:
      'Each additional state filing beyond the first state included in the base return. Includes nexus analysis when the additional state filing involves apportionment.',
    billingType: 'on_acceptance',
    defaultPriceCents: 25000, // $250
    suggestedPriceRangeCents: { low: 10000, high: 100000 },
    isAddon: true,
    tags: ['multi-state', 'tax', 'addon'],
  },
  {
    slug: 'tax-extension',
    category: 'TAX',
    name: 'Tax Extension Preparation',
    descriptionMd:
      'Preparation of federal and state extension requests with payment voucher recommendations. Most firms include extensions in higher tiers and charge for them at the base tier.',
    billingType: 'on_acceptance',
    defaultPriceCents: 15000, // $150
    suggestedPriceRangeCents: { low: 0, high: 50000 },
    isAddon: true,
    tags: ['extension', 'tax', 'addon'],
  },
  {
    slug: 'irs-notice-response',
    category: 'TAX',
    name: 'IRS or State Notice Response',
    descriptionMd:
      'Review and response to IRS or state taxing authority notices, correspondence, and routine examination requests. Audit representation requiring tax court or formal proceedings is a separate engagement.',
    billingType: 'on_acceptance',
    defaultPriceCents: 35000, // $350
    suggestedPriceRangeCents: { low: 15000, high: 250000 },
    isAddon: true,
    tags: ['notice', 'tax', 'irs', 'addon'],
  },

  // --------------------------------------------------------------------------
  // BOOKKEEPING
  // --------------------------------------------------------------------------
  {
    slug: 'monthly-bookkeeping-low-volume',
    category: 'BOOKKEEPING',
    name: 'Monthly Bookkeeping — Low Volume',
    descriptionMd:
      'Monthly transaction coding, bank and credit card reconciliation, and general ledger maintenance for businesses with up to approximately 100 transactions per month. Includes a basic monthly financial statement package.',
    billingType: 'recurring',
    recurringInterval: 'monthly',
    defaultPriceCents: 50000, // $500
    suggestedPriceRangeCents: { low: 30000, high: 100000 },
    isAddon: false,
    tags: ['bookkeeping', 'monthly', 'recurring', 'low-volume'],
  },
  {
    slug: 'monthly-bookkeeping-mid-volume',
    category: 'BOOKKEEPING',
    name: 'Monthly Bookkeeping — Mid Volume',
    descriptionMd:
      'Monthly bookkeeping for businesses with approximately 100–500 transactions per month. Includes reconciliation, journal entries, monthly statements, and quarterly review of the chart of accounts.',
    billingType: 'recurring',
    recurringInterval: 'monthly',
    defaultPriceCents: 100000, // $1,000
    suggestedPriceRangeCents: { low: 70000, high: 200000 },
    isAddon: false,
    tags: ['bookkeeping', 'monthly', 'recurring', 'mid-volume'],
  },
  {
    slug: 'monthly-bookkeeping-high-volume',
    category: 'BOOKKEEPING',
    name: 'Monthly Bookkeeping — High Volume',
    descriptionMd:
      "Monthly bookkeeping for businesses with 500+ transactions per month or multiple entities. Includes faster cadence reconciliation, monthly close oversight, and coordination with the firm's tax team for year-round planning.",
    billingType: 'recurring',
    recurringInterval: 'monthly',
    defaultPriceCents: 180000, // $1,800
    suggestedPriceRangeCents: { low: 120000, high: 400000 },
    isAddon: false,
    tags: ['bookkeeping', 'monthly', 'recurring', 'high-volume'],
  },
  {
    slug: 'catch-up-bookkeeping',
    category: 'BOOKKEEPING',
    name: 'Catch-Up / Cleanup Bookkeeping',
    descriptionMd:
      'One-time project to bring books current from an out-of-date or incomplete state. Priced based on number of months, number of accounts, and document availability. Most firms scope this as a separate engagement before starting monthly bookkeeping.',
    billingType: 'on_acceptance',
    defaultPriceCents: 250000, // $2,500
    suggestedPriceRangeCents: { low: 75000, high: 2000000 },
    isAddon: false,
    tags: ['cleanup', 'bookkeeping', 'one-time'],
    importNotes:
      'Always scope catch-up work as a fixed-fee project separately from ongoing bookkeeping. Mixing them is the most common source of scope creep.',
  },
  {
    slug: 'sales-tax-filing',
    category: 'BOOKKEEPING',
    name: 'Sales & Use Tax Filing',
    descriptionMd:
      'Monthly or quarterly state and local sales/use tax return preparation and filing for a single jurisdiction. Multi-state nexus analysis is a separate advisory engagement.',
    billingType: 'recurring',
    recurringInterval: 'monthly',
    defaultPriceCents: 15000, // $150
    suggestedPriceRangeCents: { low: 7500, high: 75000 },
    isAddon: true,
    tags: ['sales-tax', 'compliance'],
  },
  {
    slug: 'year-end-1099',
    category: 'BOOKKEEPING',
    name: '1099 Preparation & Filing',
    descriptionMd:
      'Annual preparation and filing of Forms 1099-NEC and 1099-MISC for vendor payments. Includes W-9 collection support and electronic filing with the IRS.',
    billingType: 'on_acceptance',
    defaultPriceCents: 25000, // $250
    suggestedPriceRangeCents: { low: 10000, high: 150000 },
    isAddon: false,
    tags: ['1099', 'year-end', 'compliance'],
  },

  // --------------------------------------------------------------------------
  // AUDIT
  // --------------------------------------------------------------------------
  {
    slug: 'financial-statement-audit',
    category: 'AUDIT',
    name: 'Financial Statement Audit',
    descriptionMd:
      'Audit of financial statements performed in accordance with U.S. generally accepted auditing standards (GAAS) issued by the AICPA. Scope, deliverables, and timeline are established in the audit engagement letter consistent with AU-C 210.',
    billingType: 'on_acceptance',
    defaultPriceCents: 1500000, // $15,000
    suggestedPriceRangeCents: { low: 750000, high: 25000000 },
    isAddon: false,
    tags: ['audit', 'attest', 'gaas'],
    importNotes:
      'Audit fees are typically estimated as a range with an upper limit in the engagement letter. Most firms tie fee adjustments to specifically defined triggering events (scope changes, material weaknesses requiring extended procedures, etc.).',
  },
  {
    slug: 'review-engagement',
    category: 'AUDIT',
    name: 'Review Engagement (SSARS 90)',
    descriptionMd:
      'Review of financial statements performed under SSARS, providing limited assurance. Typically appropriate for entities required to provide reviewed financial statements to lenders or other third parties without a full audit.',
    billingType: 'on_acceptance',
    defaultPriceCents: 750000, // $7,500
    suggestedPriceRangeCents: { low: 350000, high: 1500000 },
    isAddon: false,
    tags: ['review', 'ssars', 'attest'],
  },
  {
    slug: 'compilation',
    category: 'AUDIT',
    name: 'Compilation (SSARS 80)',
    descriptionMd:
      'Compilation of financial statements without providing assurance, performed under SSARS. Suitable for management-use or limited third-party distribution.',
    billingType: 'on_acceptance',
    defaultPriceCents: 200000, // $2,000
    suggestedPriceRangeCents: { low: 100000, high: 750000 },
    isAddon: false,
    tags: ['compilation', 'ssars'],
  },
  {
    slug: 'agreed-upon-procedures',
    category: 'AUDIT',
    name: 'Agreed-Upon Procedures (SSAE 19)',
    descriptionMd:
      "Agreed-upon procedures engagement performed under SSAE 19. Procedures, scope, and reporting are tailored to the specified parties' needs and documented in the engagement letter.",
    billingType: 'on_acceptance',
    defaultPriceCents: 500000, // $5,000
    suggestedPriceRangeCents: { low: 200000, high: 2500000 },
    isAddon: false,
    tags: ['aup', 'ssae', 'attest'],
  },
  {
    slug: 'single-audit',
    category: 'AUDIT',
    name: 'Single Audit (Uniform Guidance)',
    descriptionMd:
      'Audit performed under the Uniform Guidance (2 CFR 200, Subpart F) for entities expending federal awards above the threshold. Includes the Schedule of Expenditures of Federal Awards and major program testing.',
    billingType: 'on_acceptance',
    defaultPriceCents: 1000000, // $10,000
    suggestedPriceRangeCents: { low: 500000, high: 7500000 },
    isAddon: true,
    tags: ['single-audit', 'uniform-guidance', 'federal'],
  },
  {
    slug: 'employee-benefit-plan-audit',
    category: 'AUDIT',
    name: 'Employee Benefit Plan Audit (Form 5500)',
    descriptionMd:
      'Audit of employee benefit plan financial statements required for Form 5500 filing. Performed under AICPA standards and DOL requirements.',
    billingType: 'on_acceptance',
    defaultPriceCents: 850000, // $8,500
    suggestedPriceRangeCents: { low: 500000, high: 2500000 },
    isAddon: false,
    tags: ['ebp-audit', '5500', 'erisa'],
  },

  // --------------------------------------------------------------------------
  // ADVISORY
  // --------------------------------------------------------------------------
  {
    slug: 'tax-planning-session',
    category: 'ADVISORY',
    name: 'Tax Planning Session',
    descriptionMd:
      'Scheduled tax planning meeting to review current-year position, identify planning opportunities, and project year-end liability. Typically a 60–90 minute session with written summary of recommendations.',
    billingType: 'on_completion',
    defaultPriceCents: 75000, // $750
    suggestedPriceRangeCents: { low: 25000, high: 350000 },
    isAddon: false,
    tags: ['planning', 'tax', 'advisory'],
  },
  {
    slug: 'entity-selection-consultation',
    category: 'ADVISORY',
    name: 'Entity Selection Consultation',
    descriptionMd:
      'Analysis and recommendation of business entity structure for a new venture or restructuring. Includes federal and state tax projections under each viable structure and coordination with legal counsel on formation documents.',
    billingType: 'on_completion',
    defaultPriceCents: 150000, // $1,500
    suggestedPriceRangeCents: { low: 75000, high: 500000 },
    isAddon: false,
    tags: ['entity', 'advisory', 'planning'],
  },
  {
    slug: 'ma-buy-side-advisory',
    category: 'ADVISORY',
    name: 'Buy-Side M&A Advisory',
    descriptionMd:
      'Advisory services for a buyer evaluating an acquisition target. Scope may include quality of earnings review, tax structure analysis, and deal-document review. Each engagement is scoped individually based on transaction size and complexity.',
    billingType: 'hourly',
    defaultPriceCents: 35000, // $350/hr placeholder
    suggestedPriceRangeCents: { low: 20000, high: 100000 },
    isAddon: false,
    tags: ['m-and-a', 'advisory', 'transaction'],
  },
  {
    slug: 'ma-sell-side-advisory',
    category: 'ADVISORY',
    name: 'Sell-Side M&A Advisory',
    descriptionMd:
      'Advisory services for a seller preparing for or executing a sale. Scope may include sell-side QoE, tax structure optimization, and post-sale tax planning. Each engagement is scoped individually.',
    billingType: 'hourly',
    defaultPriceCents: 35000, // $350/hr placeholder
    suggestedPriceRangeCents: { low: 20000, high: 100000 },
    isAddon: false,
    tags: ['m-and-a', 'advisory', 'transaction'],
  },
  {
    slug: 'retirement-plan-design',
    category: 'ADVISORY',
    name: 'Retirement Plan Design Consultation',
    descriptionMd:
      "Analysis of retirement plan options (SEP, SIMPLE, Solo 401(k), traditional 401(k), defined benefit, cash balance) appropriate for the client's situation, with projected contribution capacity and tax impact.",
    billingType: 'on_completion',
    defaultPriceCents: 150000, // $1,500
    suggestedPriceRangeCents: { low: 75000, high: 500000 },
    isAddon: false,
    tags: ['retirement', 'planning', 'advisory'],
  },
  {
    slug: 'cost-segregation-coordination',
    category: 'ADVISORY',
    name: 'Cost Segregation Study Coordination',
    descriptionMd:
      'Coordination with a third-party cost segregation specialist for a real-estate-owning client, including pre-study cost-benefit analysis and post-study integration into the tax return.',
    billingType: 'on_completion',
    defaultPriceCents: 200000, // $2,000
    suggestedPriceRangeCents: { low: 100000, high: 750000 },
    isAddon: true,
    tags: ['cost-seg', 'real-estate', 'advisory'],
  },

  // --------------------------------------------------------------------------
  // PAYROLL
  // --------------------------------------------------------------------------
  {
    slug: 'payroll-processing-monthly',
    category: 'PAYROLL',
    name: 'Payroll Processing — Monthly',
    descriptionMd:
      'Full-service payroll processing including paycheck calculation, direct deposit, federal and state withholding remittance, and monthly tax deposits. Priced per pay period and per employee.',
    billingType: 'recurring',
    recurringInterval: 'monthly',
    defaultPriceCents: 25000, // $250
    suggestedPriceRangeCents: { low: 10000, high: 150000 },
    isAddon: false,
    tags: ['payroll', 'recurring'],
  },
  {
    slug: 'payroll-tax-quarterly-filings',
    category: 'PAYROLL',
    name: 'Quarterly Payroll Tax Filings (941, State)',
    descriptionMd:
      'Quarterly preparation and filing of federal Form 941 and applicable state employment tax returns. Usually bundled into monthly payroll processing but offered separately for firms providing tax-filings-only service.',
    billingType: 'recurring',
    recurringInterval: 'quarterly',
    defaultPriceCents: 25000, // $250/quarter
    suggestedPriceRangeCents: { low: 15000, high: 100000 },
    isAddon: true,
    tags: ['payroll', '941', 'quarterly'],
  },
  {
    slug: 'workers-comp-audit-support',
    category: 'PAYROLL',
    name: 'Workers Compensation Audit Support',
    descriptionMd:
      'Preparation of supporting schedules and direct response to insurance carrier workers compensation audit requests. Most engagements are once per policy year.',
    billingType: 'on_acceptance',
    defaultPriceCents: 35000, // $350
    suggestedPriceRangeCents: { low: 15000, high: 150000 },
    isAddon: true,
    tags: ['workers-comp', 'audit-support'],
  },
  {
    slug: 'payroll-year-end',
    category: 'PAYROLL',
    name: 'Year-End Payroll Forms (W-2, W-3)',
    descriptionMd:
      'Annual preparation and filing of Form W-2 for each employee and Form W-3 transmittal with the SSA. Includes year-end reconciliation of payroll-tax accounts.',
    billingType: 'on_acceptance',
    defaultPriceCents: 35000, // $350
    suggestedPriceRangeCents: { low: 15000, high: 150000 },
    isAddon: false,
    tags: ['payroll', 'w-2', 'year-end'],
  },

  // --------------------------------------------------------------------------
  // CFO & CONTROLLER
  // --------------------------------------------------------------------------
  {
    slug: 'fractional-controller',
    category: 'CFO',
    name: 'Fractional Controller Services',
    descriptionMd:
      "Outsourced controller-level oversight of monthly accounting close, internal control review, management reporting, and coordination with the firm's tax and audit teams. Scaled to the client's revenue and complexity.",
    billingType: 'recurring',
    recurringInterval: 'monthly',
    defaultPriceCents: 250000, // $2,500
    suggestedPriceRangeCents: { low: 100000, high: 600000 },
    isAddon: false,
    tags: ['controller', 'recurring', 'oversight'],
  },
  {
    slug: 'fractional-cfo',
    category: 'CFO',
    name: 'Fractional CFO Services',
    descriptionMd:
      "Outsourced CFO providing financial leadership including forecasting, KPI tracking, cash management, board reporting, and capital strategy. Engagement depth scales with the client's stage and needs.",
    billingType: 'recurring',
    recurringInterval: 'monthly',
    defaultPriceCents: 600000, // $6,000
    suggestedPriceRangeCents: { low: 250000, high: 2500000 },
    isAddon: false,
    tags: ['cfo', 'recurring', 'strategic'],
  },
  {
    slug: 'cash-flow-forecast-13-week',
    category: 'CFO',
    name: '13-Week Cash Flow Forecast',
    descriptionMd:
      'Rolling 13-week cash flow projection with weekly updates and variance analysis. Most useful for clients managing tight working capital or executing a turnaround.',
    billingType: 'recurring',
    recurringInterval: 'weekly',
    defaultPriceCents: 75000, // $750/week
    suggestedPriceRangeCents: { low: 35000, high: 250000 },
    isAddon: true,
    tags: ['cash-flow', 'forecast', 'recurring'],
  },
  {
    slug: 'annual-budget-preparation',
    category: 'CFO',
    name: 'Annual Budget Preparation',
    descriptionMd:
      'Development of the annual operating budget including revenue model, expense plan, and capital expenditure schedule. Includes departmental review meetings and board-ready presentation.',
    billingType: 'on_completion',
    defaultPriceCents: 500000, // $5,000
    suggestedPriceRangeCents: { low: 200000, high: 2500000 },
    isAddon: true,
    tags: ['budget', 'planning', 'annual'],
  },
  {
    slug: 'kpi-reporting-monthly',
    category: 'CFO',
    name: 'Monthly KPI Reporting',
    descriptionMd:
      "Monthly KPI dashboard tailored to the client's business model, with variance commentary versus budget and prior period. Delivered as a structured report ready for board or leadership review.",
    billingType: 'recurring',
    recurringInterval: 'monthly',
    defaultPriceCents: 150000, // $1,500
    suggestedPriceRangeCents: { low: 75000, high: 500000 },
    isAddon: true,
    tags: ['kpi', 'reporting', 'recurring'],
  },
  {
    slug: 'fundraising-financial-prep',
    category: 'CFO',
    name: 'Fundraising Financial Preparation',
    descriptionMd:
      'Preparation of financial materials for an equity or debt fundraising round, including historical financial cleanup, projection model, and supporting schedules requested by lenders or investors.',
    billingType: 'on_completion',
    defaultPriceCents: 1000000, // $10,000
    suggestedPriceRangeCents: { low: 500000, high: 5000000 },
    isAddon: true,
    tags: ['fundraising', 'capital', 'project'],
  },
];

/**
 * Convenience: services grouped by category for UI rendering.
 */
export function servicesByCategory() {
  const grouped: Record<string, ServiceTemplate[]> = {};
  for (const s of SYSTEM_SERVICE_TEMPLATES) {
    (grouped[s.category] ??= []).push(s);
  }
  return grouped;
}
