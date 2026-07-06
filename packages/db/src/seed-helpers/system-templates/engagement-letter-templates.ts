// SPDX-License-Identifier: Elastic-2.0
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
    // General-purpose client letter for the Clients-list mail merge. Uses
    // the mail-merge tokens (client.display_name / client.address_block_html
    // / firm.* / today) and ships a full letterhead so the merged PDF looks
    // like a real letter out of the box.
    slug: 'general-client-letter',
    name: 'General Client Letter',
    bodyHtml: `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: Letter; margin: 1in; }
  body { font: 12pt Georgia, "Times New Roman", serif; color: #1a1a1a; }
  .letterhead { border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; margin-bottom: 28px; }
  .firm-name { font-size: 20pt; font-weight: 700; font-family: Arial, Helvetica, sans-serif; }
  .firm-contact { font-size: 9pt; color: #555; margin-top: 4px; }
  .date { margin: 0 0 20px; }
  .recipient { margin: 0 0 24px; line-height: 1.35; }
  .recipient .name { font-weight: 700; }
  p { line-height: 1.5; margin: 0 0 12px; }
  .closing { margin-top: 32px; }
  .sig-name { margin-top: 40px; font-weight: 700; }
</style>
</head>
<body>
  <div class="letterhead">
    <div class="firm-name">{{ firm.name }}</div>
    <div class="firm-contact">{{ firm.support_phone }} &middot; {{ firm.support_email }} &middot; {{ firm.support_web }}</div>
  </div>

  <p class="date">{{ today }}</p>

  <div class="recipient">
    <div class="name">{{ client.display_name }}</div>
    {{{ client.address_block_html }}}
  </div>

  {{#if client.primary_contact}}<p>Dear {{ client.primary_contact }},</p>{{else}}<p>Dear {{ client.display_name }},</p>{{/if}}

  <p>[ Replace this paragraph with the body of your letter. Insert variables
  from the picker &mdash; for example the client name, mailing address, or
  today&rsquo;s date &mdash; and they are filled in for each recipient. ]</p>

  <p>Please contact our office with any questions.</p>

  <p class="closing">Sincerely,</p>
  <p class="sig-name">{{ firm.name }}</p>
</body>
</html>`,
  },
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
