// SPDX-License-Identifier: Elastic-2.0
//
// System engagement-template starter pack (CLAUDE.md decision #24). Firms
// import these into engagement_template and edit/rename freely afterward.

export type SystemFeeStructure =
  | 'HOURLY'
  | 'HOURLY_NTE'
  | 'FIXED_FEE'
  | 'FIXED_FEE_WITH_MILESTONES'
  | 'RECURRING_SUBSCRIPTION';

export interface SystemEngagementTemplate {
  slug: string;
  name: string;
  defaultFeeStructure: SystemFeeStructure;
  defaultFeeAmountCents?: number;
  defaultBudgetHours?: number;
  /** Mustache name pattern resolved at engagement creation. */
  namePattern?: string;
}

export const SYSTEM_ENGAGEMENT_TEMPLATES: SystemEngagementTemplate[] = [
  {
    slug: 'individual-1040',
    name: 'Individual Tax Return (1040)',
    defaultFeeStructure: 'FIXED_FEE',
    defaultFeeAmountCents: 75000,
    defaultBudgetHours: 6,
    namePattern: '{{client.name}} — 1040 {{period.year}}',
  },
  {
    slug: 'business-1120s',
    name: 'S-Corporation Return (1120-S)',
    defaultFeeStructure: 'FIXED_FEE',
    defaultFeeAmountCents: 180000,
    defaultBudgetHours: 14,
    namePattern: '{{client.name}} — 1120-S {{period.year}}',
  },
  {
    slug: 'partnership-1065',
    name: 'Partnership Return (1065)',
    defaultFeeStructure: 'FIXED_FEE',
    defaultFeeAmountCents: 180000,
    defaultBudgetHours: 14,
    namePattern: '{{client.name}} — 1065 {{period.year}}',
  },
  {
    slug: 'monthly-bookkeeping',
    name: 'Monthly Bookkeeping',
    defaultFeeStructure: 'RECURRING_SUBSCRIPTION',
    defaultFeeAmountCents: 50000,
    defaultBudgetHours: 5,
    namePattern: '{{client.name}} — Bookkeeping {{period.label}}',
  },
  {
    slug: 'financial-statement-review',
    name: 'Financial Statement Review',
    defaultFeeStructure: 'FIXED_FEE_WITH_MILESTONES',
    defaultFeeAmountCents: 600000,
    defaultBudgetHours: 40,
    namePattern: '{{client.name}} — Review {{period.year}}',
  },
];
