import type { TermsTemplate } from './types';

/**
 * System engagement-letter (terms) templates.
 *
 * Generic scaffolds aligned to public AICPA standards. They are NOT
 * legal advice and NOT a substitute for engagement-letter language
 * reviewed by counsel familiar with the firm's jurisdiction, services,
 * and risk profile. Every template renders in the firm's UI with a
 * non-deletable banner reminding the firm to review before sending.
 *
 * Merge tokens follow mustache syntax and are resolved by the visual
 * block editor at proposal-send time:
 *   {{ firm.legal_name }}              {{ client.legal_name }}
 *   {{ firm.address }}                 {{ client.address }}
 *   {{ firm.signatory_name }}          {{ client.primary_contact }}
 *   {{ engagement.scope_summary }}     {{ engagement.fee_text }}
 *   {{ engagement.tax_year }}          {{ engagement.start_date }}
 *   {{ engagement.deliverables }}      {{ today }}
 */
export const SYSTEM_TERMS_TEMPLATES: TermsTemplate[] = [
  // --------------------------------------------------------------------------
  // 1. Individual Tax Engagement
  // --------------------------------------------------------------------------
  {
    slug: 'tax-individual-engagement-letter',
    name: 'Individual Tax Engagement Letter',
    primaryCategory: 'TAX',
    source: 'industry_generic',
    standardsReferenced: ['IRS Circular 230', 'AICPA Statements on Standards for Tax Services'],
    bodyMd: `## Individual Tax Return Engagement

**Engagement Date:** {{ today }}
**Tax Year:** {{ engagement.tax_year }}
**Firm:** {{ firm.legal_name }}
**Client:** {{ client.legal_name }}

### Purpose

This letter sets the terms of the engagement under which {{ firm.legal_name }} ("the Firm") will prepare {{ client.legal_name }}'s ("the Client") federal and state individual income tax returns for the tax year above.

### Scope of Services

The Firm will prepare the returns described in the accepted proposal:

{{ engagement.scope_summary }}

Services not listed in the accepted proposal are outside the scope of this engagement and may be performed only under a separate written agreement or change order.

### Client Responsibilities

The Client is responsible for:

- Providing complete, accurate, and timely information needed to prepare the returns, including all forms (W-2, 1099, K-1, brokerage statements, etc.).
- Reviewing the returns before signing and filing, including verifying that all income, deductions, and credits are correctly reflected.
- Maintaining documentation supporting the items reported on the returns for the period required by applicable law.
- Disclosing material facts that could affect the Firm's preparation, including foreign accounts, virtual currency holdings, and reportable transactions.

### Firm Responsibilities

The Firm will prepare the returns based on information the Client provides. The Firm will exercise professional judgment in interpreting tax law and applying it to the Client's facts. The Firm is not engaged to audit, review, or verify the underlying information unless that scope is specifically described in the accepted proposal.

### Limitations

This engagement does not include representation before the IRS or any state taxing authority in connection with audits, examinations, or appeals, unless described in the accepted proposal or in a separate engagement letter.

### Fees and Payment

{{ engagement.fee_text }}

### Term and Termination

This engagement begins on the date of acceptance and ends upon delivery and filing of the returns. Either party may terminate this engagement at any time by written notice. Fees for work performed through termination remain due.

### Confidentiality and Privacy

The Firm will treat the Client's information as confidential except as required by law (including, where applicable, IRS Form 8867 due diligence requirements) and except as required to perform the services.

### Acknowledgment

By accepting the linked proposal, the Client acknowledges and agrees to these terms.

---

*This engagement letter is a starting point. Firms should review with their professional liability carrier and legal counsel before using.*`,
    importNotes:
      'Most firms add language addressing specific situations they handle (foreign account disclosures, virtual currency, gift-tax-implication transactions, etc.). Customize before shipping to clients.',
  },

  // --------------------------------------------------------------------------
  // 2. Business Tax Engagement
  // --------------------------------------------------------------------------
  {
    slug: 'tax-business-engagement-letter',
    name: 'Business Tax Engagement Letter',
    primaryCategory: 'TAX',
    source: 'industry_generic',
    standardsReferenced: ['IRS Circular 230', 'AICPA Statements on Standards for Tax Services'],
    bodyMd: `## Business Tax Return Engagement

**Engagement Date:** {{ today }}
**Tax Year:** {{ engagement.tax_year }}
**Firm:** {{ firm.legal_name }}
**Client:** {{ client.legal_name }}

### Purpose

This letter sets the terms of the engagement under which {{ firm.legal_name }} ("the Firm") will prepare {{ client.legal_name }}'s ("the Client") federal and state business income tax returns for the tax year identified above.

### Scope of Services

The Firm will prepare the returns and supporting forms described in the accepted proposal:

{{ engagement.scope_summary }}

Items outside the listed scope — including but not limited to amendments to prior-year returns, multi-entity coordination beyond the listed entities, owner individual returns not listed, and tax planning sessions not listed — require a separate engagement.

### Client Responsibilities

The Client is responsible for:

- Maintaining accurate books and records adequate to support the returns.
- Providing trial balance, supporting schedules, and source documentation in usable form by the deadlines stated in the accepted proposal.
- Reviewing draft returns before authorizing filing and verifying that all material items are correctly reflected.
- Maintaining documentation supporting the returns for the period required by applicable law.
- Disclosing material transactions and events that affect the returns, including ownership changes, mergers, dispositions, foreign activity, and reportable transactions.

### Firm Responsibilities

The Firm will prepare the returns based on the Client's books, records, and disclosed information. The Firm is not engaged to perform an audit, review, or compilation of the underlying financial statements unless that scope is described in the accepted proposal. Book-to-tax adjustments will be made as needed to convert the Client's financial information to the tax basis.

### Limitations

The Firm's services under this engagement do not include:

- Representation before the IRS or any state taxing authority unless separately engaged.
- Legal advice or legal opinions, which are outside the Firm's licensed scope.
- Verification of the underlying accuracy of the Client's accounting records.

### Fees and Payment

{{ engagement.fee_text }}

### Term and Termination

This engagement begins on the date of acceptance and ends upon delivery and filing of the returns covered. Either party may terminate this engagement at any time by written notice. Fees for work performed through termination remain due.

### Acknowledgment

By accepting the linked proposal, the Client acknowledges and agrees to these terms.

---

*This engagement letter is a starting point. Firms should review with their professional liability carrier and legal counsel before using.*`,
    importNotes:
      'Pass-through entities (1120-S, 1065) typically need additional language about owner basis, K-1 timing, and coordination with owner individual returns. Add jurisdiction-specific entity language as needed.',
  },

  // --------------------------------------------------------------------------
  // 3. Monthly Bookkeeping Engagement (Preparation under AR-C 70)
  // --------------------------------------------------------------------------
  {
    slug: 'bookkeeping-monthly-engagement-letter',
    name: 'Monthly Bookkeeping Engagement Letter',
    primaryCategory: 'BOOKKEEPING',
    source: 'aicpa_aligned',
    standardsReferenced: ['AR-C 70'],
    bodyMd: `## Monthly Bookkeeping & Financial Statement Preparation Engagement

**Engagement Date:** {{ today }}
**Engagement Start:** {{ engagement.start_date }}
**Firm:** {{ firm.legal_name }}
**Client:** {{ client.legal_name }}

### Purpose

This letter sets the terms of the engagement under which {{ firm.legal_name }} ("the Firm") will perform monthly bookkeeping services and prepare financial statements for {{ client.legal_name }} ("the Client"). The financial statement preparation is performed in accordance with AR-C 70 (Preparation of Financial Statements) issued by the AICPA Accounting and Review Services Committee.

### Scope of Services

Services included in this engagement are described in the accepted proposal:

{{ engagement.scope_summary }}

The financial statements prepared under this engagement will not be subject to compilation, review, or audit procedures, and accordingly the Firm will not express an opinion or provide any assurance on the financial statements.

### No Assurance Provided

Because this is a preparation engagement under AR-C 70:

- The Firm will not verify the accuracy or completeness of information provided by the Client.
- Each page of the financial statements will include a statement indicating that no assurance is provided, or the financial statements will be accompanied by a disclaimer.
- The Firm is not required to determine whether the financial statements are presented in accordance with the applicable financial reporting framework.

### Client Responsibilities

The Client is responsible for:

- Maintaining the underlying records and providing complete information necessary for the Firm to perform the services.
- The accuracy and completeness of the information provided to the Firm.
- Selection of the financial reporting framework (e.g., U.S. GAAP, tax basis, cash basis).
- Adjusting the financial statements to correct any material misstatements identified.
- Internal controls relevant to the Client's operations.

### Firm Responsibilities

The Firm will perform the bookkeeping and financial statement preparation services using its professional judgment. The Firm will inform the Client of any material misstatements identified during the engagement.

### Fees and Payment

{{ engagement.fee_text }}

### Term and Termination

This engagement is ongoing on the cadence stated in the accepted proposal. Either party may terminate this engagement with thirty (30) days' written notice. Fees for work performed through termination remain due.

### Out-of-Scope Work

Services outside the stated scope — including but not limited to catch-up or cleanup work covering periods before the engagement start date, tax return preparation, payroll services, audit, review, or compilation engagements, and advisory consulting — require a separate engagement.

### Acknowledgment

By accepting the linked proposal, the Client acknowledges and agrees to these terms.

---

*This engagement letter is a starting point. Firms should review with their professional liability carrier and legal counsel before using.*`,
    importNotes:
      'If your firm does not prepare financial statements (only bookkeeping), remove the AR-C 70 references. If you perform compilation or review engagements instead, use the appropriate AR-C 80 or AR-C 90 scaffold (not currently shipped — author one for your specific service mix).',
  },

  // --------------------------------------------------------------------------
  // 4. Audit Engagement (AU-C 210)
  // --------------------------------------------------------------------------
  {
    slug: 'audit-engagement-letter',
    name: 'Financial Statement Audit Engagement Letter',
    primaryCategory: 'AUDIT',
    source: 'aicpa_aligned',
    standardsReferenced: ['AU-C 210', 'AU-C 200', 'AU-C 580'],
    bodyMd: `## Financial Statement Audit Engagement

**Engagement Date:** {{ today }}
**Period Under Audit:** {{ engagement.tax_year }}
**Firm:** {{ firm.legal_name }}
**Client:** {{ client.legal_name }}

### Purpose

This letter sets the terms of the engagement under which {{ firm.legal_name }} ("the Firm") will audit the financial statements of {{ client.legal_name }} ("the Client") for the period stated above. The audit will be conducted in accordance with auditing standards generally accepted in the United States of America (GAAS), as issued by the AICPA Auditing Standards Board.

### Objectives and Scope

The objective of the audit is to obtain reasonable assurance about whether the financial statements as a whole are free from material misstatement, whether due to fraud or error, and to issue an auditor's report that includes the Firm's opinion. Reasonable assurance is a high level of assurance, but it is not absolute assurance.

Because of the inherent limitations of an audit, together with the inherent limitations of internal control, an unavoidable risk exists that some material misstatements may not be detected, even though the audit is properly planned and performed in accordance with GAAS.

### Management Responsibilities

Management is responsible for:

- The preparation and fair presentation of the financial statements in accordance with the applicable financial reporting framework.
- The design, implementation, and maintenance of internal control relevant to the preparation and fair presentation of financial statements that are free from material misstatement, whether due to fraud or error.
- Providing the Firm with access to all information relevant to the preparation and fair presentation of the financial statements, additional information requested by the Firm, and unrestricted access to persons within the entity from whom audit evidence may be obtained.
- Providing written representations to the Firm at the conclusion of the audit as required by AU-C 580.

### Firm Responsibilities

The Firm's responsibilities are to plan and perform the audit in accordance with GAAS and to express an opinion based on the audit. The Firm will exercise professional judgment and maintain professional skepticism throughout the audit.

### Communication

The Firm will communicate to those charged with governance any significant findings from the audit, including significant deficiencies and material weaknesses in internal control, fraud or illegal acts identified, and any disagreements with management.

### Fees and Payment

{{ engagement.fee_text }}

Fees may be adjusted if circumstances arise that require significantly more time than anticipated, including but not limited to material weaknesses requiring extended procedures, restatements, or scope changes. Any adjustment will be discussed with the Client in advance.

### Independence

The Firm will maintain independence in accordance with applicable AICPA, state board, and (if applicable) DOL or GAO independence requirements throughout the engagement.

### Acknowledgment

By accepting the linked proposal and signing this engagement letter, the Client and Management acknowledge and agree to these terms.

---

*This engagement letter is a starting point. Firms should review with their professional liability carrier, peer reviewer, and legal counsel before using. Audit engagement letters typically require additional jurisdiction-specific and entity-specific language.*`,
    importNotes:
      'Audit engagement letters carry significant peer-review scrutiny. This scaffold is intentionally minimal — most firms will need to add language about specific complementary services, predecessor auditor communications, internal control communications, group-audit considerations, and other AU-C-specific requirements applicable to the engagement.',
  },

  // --------------------------------------------------------------------------
  // 5. Advisory / Non-Attest Engagement
  // --------------------------------------------------------------------------
  {
    slug: 'advisory-non-attest-engagement-letter',
    name: 'Advisory Services Engagement Letter',
    primaryCategory: 'ADVISORY',
    source: 'industry_generic',
    standardsReferenced: ['AICPA Code of Professional Conduct'],
    bodyMd: `## Advisory Services Engagement

**Engagement Date:** {{ today }}
**Firm:** {{ firm.legal_name }}
**Client:** {{ client.legal_name }}

### Purpose

This letter sets the terms of the engagement under which {{ firm.legal_name }} ("the Firm") will provide advisory and consulting services to {{ client.legal_name }} ("the Client") as described in the accepted proposal.

### Scope of Services

{{ engagement.scope_summary }}

### Non-Attest Nature of Services

These services are non-attest services. The Firm will not provide an audit, review, compilation, or other form of assurance on any financial statements, projections, forecasts, or other deliverables produced under this engagement. Deliverables are intended for the Client's internal use and decision-making and are not appropriate for third-party reliance unless specifically arranged in writing.

### Client Responsibilities

The Client is responsible for:

- Making all management decisions and performing all management functions.
- Designating an individual with suitable skills, knowledge, and experience to oversee the services.
- Evaluating the adequacy and results of the services.
- Accepting responsibility for the results of the services.
- Establishing and maintaining internal control, including monitoring activities.

### Firm Responsibilities

The Firm will perform the agreed services with reasonable professional skill and care. Recommendations and analyses are intended to inform the Client's decisions; final decisions remain with the Client.

### Limitations

This engagement is for the specific services described. The Firm's role is advisory only. The Firm does not assume management responsibility or any fiduciary duty to the Client beyond what is required by applicable professional standards.

### Fees and Payment

{{ engagement.fee_text }}

### Term and Termination

This engagement begins on the date of acceptance and ends upon delivery of the agreed services. For ongoing advisory engagements, either party may terminate with thirty (30) days' written notice. Fees for work performed through termination remain due.

### Acknowledgment

By accepting the linked proposal, the Client acknowledges and agrees to these terms.

---

*This engagement letter is a starting point. Firms should review with their professional liability carrier and legal counsel before using.*`,
    importNotes:
      'Advisory engagement letters benefit from explicit scope and explicit exclusion language. Vague scope is the leading driver of scope creep and PL claims in advisory work. Edit the scope_summary token output carefully.',
  },

  // --------------------------------------------------------------------------
  // 6. Fractional CFO / Controller Engagement
  // --------------------------------------------------------------------------
  {
    slug: 'cfo-controller-engagement-letter',
    name: 'Fractional CFO & Controller Engagement Letter',
    primaryCategory: 'CFO',
    source: 'industry_generic',
    standardsReferenced: ['AICPA Code of Professional Conduct'],
    bodyMd: `## Fractional CFO / Controller Engagement

**Engagement Date:** {{ today }}
**Engagement Start:** {{ engagement.start_date }}
**Firm:** {{ firm.legal_name }}
**Client:** {{ client.legal_name }}

### Purpose

This letter sets the terms of the engagement under which {{ firm.legal_name }} ("the Firm") will provide outsourced controller and/or CFO services to {{ client.legal_name }} ("the Client") as described in the accepted proposal.

### Scope of Services

{{ engagement.scope_summary }}

### Non-Attest Nature of Services

These services are non-attest. The Firm will not audit, review, or compile the Client's financial statements as part of this engagement. If the Client requires attest services, those will be performed under a separate engagement.

### Client Responsibilities

Consistent with the AICPA Code of Professional Conduct, the Client is responsible for:

- Designating an individual within the Client organization, with suitable skills, knowledge, and experience, to oversee the services.
- Making all management decisions and performing all management functions.
- Evaluating the adequacy and results of the services performed.
- Accepting responsibility for the results of the services.
- Establishing and maintaining internal control over financial reporting.
- Providing complete, accurate, and timely information needed to perform the services.

### Firm Responsibilities

The Firm will perform the agreed services with reasonable professional skill and care. The Firm's role is advisory; the Firm does not act as an officer or employee of the Client and does not assume management responsibility unless specifically agreed in writing.

### Communication and Reporting

The Firm will provide periodic reports, deliverables, and communications on the cadence stated in the accepted proposal. The Client agrees to provide timely responses to information requests so the Firm can meet agreed deadlines.

### Confidentiality

Each party agrees to treat the other's confidential information as confidential and to use it only for purposes of this engagement.

### Fees and Payment

{{ engagement.fee_text }}

### Term and Termination

This engagement is ongoing on the cadence stated in the accepted proposal. Either party may terminate with thirty (30) days' written notice. Fees for work performed through termination remain due.

### Acknowledgment

By accepting the linked proposal, the Client acknowledges and agrees to these terms.

---

*This engagement letter is a starting point. Firms should review with their professional liability carrier and legal counsel before using.*`,
    importNotes:
      "Fractional CFO and controller engagements where the Firm signs documents on behalf of the Client (checks, tax returns, regulatory filings) raise additional independence and licensing issues. Add specific language about which actions, if any, the Firm is authorized to take on the Client's behalf.",
  },
];
