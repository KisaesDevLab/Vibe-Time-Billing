// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P07 — Starter engagement-letter terms templates.
//
// Six templates seeded for new firms — one per service category. These
// are starting points only. The admin UI surfaces a disclaimer to that
// effect:
//
//   "These templates are starting points — review with your professional
//    liability carrier before use."
//
// Templates are written in Markdown with merge tokens. Merge tokens
// follow the pattern {{ scope.path }} resolved by `merge-tokens.ts`.
// All categories should leave room for firm-specific addenda in the
// proposal's authoring step.

import type { ServiceCategory } from './types';

export interface StarterTemplate {
  category: ServiceCategory;
  name: string;
  contentMd: string;
}

const TAX = `## Engagement letter — Tax services

**Date:** {{today}}

**To:** {{ client.name }}
**From:** {{ firm.name }}

Thank you for choosing {{ firm.name }} to prepare and file your tax
returns. This letter confirms our understanding of the terms and
objectives of our engagement.

### Scope of services
We will prepare the federal and state income-tax returns covered by
this engagement using information you provide. Our work is limited to
preparation; we will not audit, review, or otherwise verify the data
you submit.

### Your responsibilities
- Provide complete and accurate records.
- Retain all documents supporting items reported on the return for at
  least the periods required by applicable law (generally three years
  from the date a return is filed).
- Review the return before signing; you are responsible for the
  accuracy of the information you provide.

### Our responsibilities
We will perform the services in accordance with the *Statements on
Standards for Tax Services* issued by the AICPA. Final professional
judgment on positions taken rests with us.

### Fees
Fees for the services described are stated in the accompanying
proposal and will be invoiced as work progresses. Out-of-pocket
expenses (filing fees, postage, electronic-filing charges, etc.) are
billed at cost.

### Limitations
Our services do not include any procedures to detect fraud, defalcation,
or other irregularities. We are not responsible for state or local
filings outside the scope listed in the proposal.

### Term
This engagement remains in effect until terminated in writing by either
party. Either party may terminate at any time on written notice; fees
for work performed through the termination date are due immediately.

By signing the accompanying proposal you accept these terms.`;

const BOOKKEEPING = `## Engagement letter — Bookkeeping services

**Date:** {{today}}

**To:** {{ client.name }}
**From:** {{ firm.name }}

This letter confirms our understanding of the terms under which
{{ firm.name }} will provide ongoing bookkeeping services to
{{ client.name }}.

### Scope of services
We will record the financial transactions of your business using the
records and documentation you provide. We will reconcile bank and
credit-card accounts monthly and produce a basic income statement and
balance sheet at the close of each period.

### Your responsibilities
- Provide bank, credit-card, and other supporting statements promptly
  after period close.
- Categorize ambiguous transactions on request.
- Approve the financial statements we produce; the statements are
  yours and you are responsible for their use.

### Our responsibilities
We will perform the services in accordance with applicable AICPA
preparation-engagement standards. These services do not constitute an
audit, review, or compilation of your financial statements, and we
will not express any assurance on them.

### Fees
Recurring monthly fees are stated in the accompanying proposal.
Material additional work (catch-up bookkeeping, special projects) will
be quoted separately before commencement.

### Term
Services run month-to-month and may be terminated by either party on
30 days' written notice. Fees through the termination date are due
immediately.

By signing the accompanying proposal you accept these terms.`;

const AUDIT = `## Engagement letter — Audit of financial statements

**Date:** {{today}}

**To:** {{ client.name }}
**From:** {{ firm.name }}

This letter confirms the terms of the audit engagement between
{{ firm.name }} and {{ client.name }}.

### Scope
We will audit the financial statements of {{ client.name }} for the
period ended {{ engagement.end_date }}, which comprise the balance
sheet, statements of income, changes in equity, and cash flows, and
the related notes.

### Standards
We will conduct our audit in accordance with auditing standards
generally accepted in the United States of America (GAAS). Those
standards require that we plan and perform the audit to obtain
reasonable, not absolute, assurance about whether the financial
statements are free of material misstatement.

### Management's responsibilities
- Prepare and fairly present the financial statements in accordance
  with the applicable financial-reporting framework.
- Maintain effective internal control over financial reporting.
- Provide us with access to all information relevant to the
  preparation of the financial statements, additional information we
  may request, and unrestricted access to personnel.
- Provide written representations at the conclusion of the audit.

### Our responsibilities
We will issue a written report on the financial statements. Our
report may be modified or withdrawn if circumstances arise that would
preclude an unmodified opinion.

### Inherent limitations
Because of the inherent limitations of an audit, together with the
inherent limitations of internal control, an unavoidable risk exists
that some material misstatements may not be detected even though the
audit is properly planned and performed.

### Fees
Audit fees are set out in the accompanying proposal. Additional work
arising from significant changes in scope, accounting issues, or the
condition of the records will be billed at our standard hourly rates.

### Term
This engagement covers the audit period stated above. Subsequent
period audits require a new engagement letter.

By signing the accompanying proposal you accept these terms.`;

const ADVISORY = `## Engagement letter — Advisory services

**Date:** {{today}}

**To:** {{ client.name }}
**From:** {{ firm.name }}

This letter sets out the terms under which {{ firm.name }} will
provide advisory services to {{ client.name }}.

### Scope
We will provide consultation and recommendations on the matters
described in the accompanying proposal. Our work product may take
the form of memoranda, presentations, or oral advice. We will not
prepare or attest to financial statements, file tax returns, or
perform any audit or review procedures as part of this engagement.

### Your responsibilities
Decisions on whether and how to implement our recommendations rest
with management. You are responsible for evaluating the adequacy of
the services for your purposes.

### Our responsibilities
We will perform the services in accordance with the *Statements on
Standards for Consulting Services* issued by the AICPA. We do not
express any form of assurance on financial statements, tax positions,
or other information unless explicitly stated in writing.

### Limitations
Advisory deliverables are based on information available at the time
of issuance. Subsequent events may affect the conclusions; we are
under no obligation to update prior advice.

### Fees
Fees for the services described are stated in the accompanying
proposal and may be billed hourly, by milestone, or on retainer as
specified there.

### Term
Either party may terminate this engagement on written notice; fees
through the termination date are due immediately.

By signing the accompanying proposal you accept these terms.`;

const PAYROLL = `## Engagement letter — Payroll services

**Date:** {{today}}

**To:** {{ client.name }}
**From:** {{ firm.name }}

This letter confirms our understanding of the payroll services we
will provide to {{ client.name }}.

### Scope
We will process payroll on the cadence specified in the accompanying
proposal, prepare and file required payroll-tax returns, and remit
withheld amounts to the appropriate jurisdictions.

### Your responsibilities
- Authorize payroll runs and approve net-pay totals before transmission.
- Maintain employee classification records (W-2 vs 1099, exempt vs
  non-exempt, state of residence).
- Promptly notify us of new hires, terminations, and rate changes.
- Fund the payroll account in advance of each scheduled run.

### Our responsibilities
We will process payroll using the information you supply. We rely on
your representations regarding employee classification and other
matters within your knowledge. We do not assume responsibility for
the accuracy of those representations.

### Fees
Recurring fees are stated in the accompanying proposal. Out-of-cycle
runs, garnishments, and other ad-hoc work are billed at our standard
hourly rates or per-event fees as listed there.

### Limitations
We do not provide HR advice, employment-law guidance, or workers'
compensation administration unless explicitly contracted in a
separate engagement letter.

### Term
Services run month-to-month and may be terminated by either party on
30 days' written notice.

By signing the accompanying proposal you accept these terms.`;

const CFO = `## Engagement letter — Outsourced CFO / controller services

**Date:** {{today}}

**To:** {{ client.name }}
**From:** {{ firm.name }}

This letter confirms our understanding of the outsourced finance
services {{ firm.name }} will provide to {{ client.name }}.

### Scope
We will act as a fractional finance leader for {{ client.name }},
providing the services itemized in the accompanying proposal. Typical
deliverables include monthly financial close oversight, cash-flow
forecasting, budgeting support, KPI reporting, and ad-hoc financial
analysis. We do not audit, review, or otherwise attest to the
financial statements as part of this engagement.

### Your responsibilities
- Provide timely access to accounting records, bank statements, and
  operational data we request.
- Make business decisions on the basis of our analysis; ultimate
  responsibility for financial outcomes remains with you.
- Notify us of material changes in the business that may affect our
  analysis or recommendations.

### Our responsibilities
We will exercise professional judgment in delivering the services and
will document material recommendations in writing. Our work product
is advisory in nature; we do not express assurance on the financial
statements.

### Fees
Recurring fees are stated in the accompanying proposal. Project-based
work outside the recurring scope is quoted separately before
commencement.

### Term
Services run month-to-month and may be terminated by either party on
30 days' written notice.

By signing the accompanying proposal you accept these terms.`;

export const STARTER_TERMS_TEMPLATES: StarterTemplate[] = [
  { category: 'TAX', name: 'Tax services — starter', contentMd: TAX },
  { category: 'BOOKKEEPING', name: 'Bookkeeping — starter', contentMd: BOOKKEEPING },
  { category: 'AUDIT', name: 'Audit of financial statements — starter', contentMd: AUDIT },
  { category: 'ADVISORY', name: 'Advisory services — starter', contentMd: ADVISORY },
  { category: 'PAYROLL', name: 'Payroll services — starter', contentMd: PAYROLL },
  { category: 'CFO', name: 'Outsourced CFO / controller — starter', contentMd: CFO },
];
