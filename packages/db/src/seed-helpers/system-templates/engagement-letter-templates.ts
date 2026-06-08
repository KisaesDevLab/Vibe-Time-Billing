// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// System engagement-letter starter pack. Imported into
// engagement_letter_template; bodyHtml supports {{ merge tokens }}.

export interface SystemLetterTemplate {
  slug: string;
  name: string;
  bodyHtml: string;
}

export const SYSTEM_LETTER_TEMPLATES: SystemLetterTemplate[] = [
  {
    slug: 'individual-1040-letter',
    name: 'Individual Tax Engagement Letter',
    bodyHtml: `<h1>Tax Engagement Letter</h1>
<p>Dear {{client.name}},</p>
<p>Thank you for engaging {{firm.name}} to prepare your individual income tax
returns (Form 1040) for the {{period.year}} tax year. This letter confirms the
terms of our engagement.</p>
<h2>Scope</h2>
<p>We will prepare your federal and state individual income tax returns from
information you provide. We will not audit or verify the data submitted.</p>
<h2>Fees</h2>
<p>Our fee is based on the engagement's agreed amount and is due upon delivery.</p>
<p>Please sign below to acknowledge these terms.</p>`,
  },
  {
    slug: 'business-tax-letter',
    name: 'Business Tax Engagement Letter',
    bodyHtml: `<h1>Business Tax Engagement Letter</h1>
<p>Dear {{client.name}},</p>
<p>This letter confirms our engagement to prepare the {{period.year}} federal and
state income tax returns for {{client.name}}.</p>
<h2>Responsibilities</h2>
<p>Management is responsible for the accuracy and completeness of the records
provided. We will prepare the returns based on those records.</p>
<h2>Fees</h2>
<p>Fees are billed per the engagement terms and are due upon delivery.</p>
<p>Please sign below to acknowledge these terms.</p>`,
  },
  {
    slug: 'bookkeeping-letter',
    name: 'Monthly Bookkeeping Engagement Letter',
    bodyHtml: `<h1>Bookkeeping Engagement Letter</h1>
<p>Dear {{client.name}},</p>
<p>This letter confirms our engagement to provide ongoing monthly bookkeeping
services for {{client.name}}, beginning {{today}}.</p>
<h2>Services</h2>
<p>We will record transactions, reconcile accounts, and deliver monthly
financial statements. This is a non-attest engagement.</p>
<h2>Fees</h2>
<p>Services are billed monthly per the engagement terms.</p>
<p>Please sign below to acknowledge these terms.</p>`,
  },
];
