// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// System client-template starter pack. Imported into client_template; these
// pre-fill the new-client wizard (defaultsJson) keyed by clientType, and may
// suggest engagement templates by slug (resolved to firm ids at import time).

export type SystemClientType = 'INDIVIDUAL' | 'BUSINESS';

export interface SystemClientTemplate {
  slug: string;
  name: string;
  clientType: SystemClientType;
  /** Wizard prefill values merged into the new-client form. */
  defaultsJson?: Record<string, unknown>;
  /** Engagement template slugs suggested for this client type. */
  defaultEngagementSlugs?: string[];
}

export const SYSTEM_CLIENT_TEMPLATES: SystemClientTemplate[] = [
  {
    slug: 'individual-1040-client',
    name: 'Individual (1040)',
    clientType: 'INDIVIDUAL',
    defaultsJson: {
      invoiceConsolidationPreference: 'SEPARATE',
    },
    defaultEngagementSlugs: ['individual-1040'],
  },
  {
    slug: 'scorp-client',
    name: 'S-Corporation',
    clientType: 'BUSINESS',
    defaultsJson: {
      entityType: 'S_CORP',
      invoiceConsolidationPreference: 'CONSOLIDATED',
    },
    defaultEngagementSlugs: ['business-1120s', 'monthly-bookkeeping'],
  },
  {
    slug: 'partnership-client',
    name: 'Partnership / LLC',
    clientType: 'BUSINESS',
    defaultsJson: {
      entityType: 'PARTNERSHIP',
      invoiceConsolidationPreference: 'CONSOLIDATED',
    },
    defaultEngagementSlugs: ['partnership-1065', 'monthly-bookkeeping'],
  },
];
