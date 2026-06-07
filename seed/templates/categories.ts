import type { ServiceCategoryDefinition } from './types';

/**
 * The 6 hard-coded service categories.
 *
 * These mirror the ENUM constraint on services_catalog.category from
 * build plan P01. The order here is the canonical display order in
 * the firm-side UI.
 */
export const SERVICE_CATEGORIES: ServiceCategoryDefinition[] = [
  {
    slug: 'TAX',
    displayName: 'Tax',
    shortDescription:
      'Federal, state, and local tax preparation, planning, and compliance for individuals, businesses, fiduciaries, and exempt organizations.',
    defaultCoaCode: '4100',
    defaultCoaLabel: 'Tax Service Revenue',
    iconHint: 'receipt-text',
    position: 1,
  },
  {
    slug: 'BOOKKEEPING',
    displayName: 'Bookkeeping',
    shortDescription:
      'Transaction coding, reconciliation, general ledger maintenance, and monthly financial statement preparation.',
    defaultCoaCode: '4200',
    defaultCoaLabel: 'Bookkeeping Service Revenue',
    iconHint: 'book-open',
    position: 2,
  },
  {
    slug: 'AUDIT',
    displayName: 'Audit & Assurance',
    shortDescription:
      'Audit, review, compilation, agreed-upon procedures, and other attest engagements performed under AICPA standards.',
    defaultCoaCode: '4300',
    defaultCoaLabel: 'Audit & Assurance Revenue',
    iconHint: 'shield-check',
    position: 3,
  },
  {
    slug: 'ADVISORY',
    displayName: 'Advisory',
    shortDescription:
      'Tax planning, entity structuring, transaction support, and other non-attest consulting engagements.',
    defaultCoaCode: '4400',
    defaultCoaLabel: 'Advisory Service Revenue',
    iconHint: 'lightbulb',
    position: 4,
  },
  {
    slug: 'PAYROLL',
    displayName: 'Payroll',
    shortDescription:
      'Payroll processing, tax filings, 1099 preparation, and workers compensation support.',
    defaultCoaCode: '4500',
    defaultCoaLabel: 'Payroll Service Revenue',
    iconHint: 'users',
    position: 5,
  },
  {
    slug: 'CFO',
    displayName: 'CFO & Controller',
    shortDescription:
      'Outsourced controller and CFO services including forecasting, KPI reporting, cash flow management, and strategic finance support.',
    defaultCoaCode: '4600',
    defaultCoaLabel: 'CFO & Controller Service Revenue',
    iconHint: 'trending-up',
    position: 6,
  },
];
