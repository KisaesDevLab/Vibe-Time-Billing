// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// System request-list starter pack. Imported into request_template (+ items);
// titlePattern/bodyPattern support {{ merge tokens }} at spawn time.

export type SystemRequestPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type SystemRequestItemKind = 'QUESTION' | 'DOCUMENT' | 'SIGNATURE';

export interface SystemRequestTemplateItem {
  label: string;
  body?: string;
  itemKind: SystemRequestItemKind;
  required: boolean;
}
export interface SystemRequestTemplate {
  slug: string;
  name: string;
  titlePattern: string;
  bodyPattern: string;
  defaultPriority: SystemRequestPriority;
  defaultDueOffsetDays?: number;
  items: SystemRequestTemplateItem[];
}

export const SYSTEM_REQUEST_TEMPLATES: SystemRequestTemplate[] = [
  {
    slug: 'individual-1040-docs',
    name: '1040 Document Request',
    titlePattern: '{{period.year}} Tax Documents — {{client.name}}',
    bodyPattern: 'Please upload the following so we can prepare your return.',
    defaultPriority: 'HIGH',
    defaultDueOffsetDays: 14,
    items: [
      { label: 'W-2 forms', itemKind: 'DOCUMENT', required: true },
      { label: '1099 forms (INT, DIV, B, NEC, etc.)', itemKind: 'DOCUMENT', required: true },
      { label: 'Mortgage interest statement (1098)', itemKind: 'DOCUMENT', required: false },
      { label: 'Charitable contribution receipts', itemKind: 'DOCUMENT', required: false },
      { label: 'Any change in dependents this year?', itemKind: 'QUESTION', required: true },
      { label: 'Signed engagement letter', itemKind: 'SIGNATURE', required: true },
    ],
  },
  {
    slug: 'business-tax-docs',
    name: 'Business Tax Document Request',
    titlePattern: '{{period.year}} Business Tax Documents — {{client.name}}',
    bodyPattern: 'Please provide the following for your business return.',
    defaultPriority: 'HIGH',
    defaultDueOffsetDays: 21,
    items: [
      { label: 'Year-end profit & loss statement', itemKind: 'DOCUMENT', required: true },
      { label: 'Year-end balance sheet', itemKind: 'DOCUMENT', required: true },
      { label: 'Bank & credit-card statements (Dec)', itemKind: 'DOCUMENT', required: true },
      { label: 'Payroll reports (W-3 / 941s)', itemKind: 'DOCUMENT', required: false },
      { label: 'Any new owners or ownership changes?', itemKind: 'QUESTION', required: true },
    ],
  },
  {
    slug: 'monthly-bookkeeping-docs',
    name: 'Monthly Bookkeeping Request',
    titlePattern: 'Bookkeeping documents — {{period.label}}',
    bodyPattern: 'Monthly close documents.',
    defaultPriority: 'MEDIUM',
    defaultDueOffsetDays: 7,
    items: [
      { label: 'Bank statements', itemKind: 'DOCUMENT', required: true },
      { label: 'Credit-card statements', itemKind: 'DOCUMENT', required: true },
      { label: 'Receipts for large/unusual expenses', itemKind: 'DOCUMENT', required: false },
    ],
  },
];
