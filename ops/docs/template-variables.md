# Template variables catalog

This document lists every variable available for substitution in email and SMS templates per [QUESTIONS.md Q28](../../QUESTIONS.md#q28--email--sms-template-customization). Templates use Handlebars-style markers: `{{namespace.field}}`.

The admin UI shows a variable picker that surfaces these. Unknown variables throw at render time so typos can't silently produce broken messages.

## How rendering works

1. Firm-side admin edits a template (text only, variable insertion only — no HTML/Markdown rendering).
2. At send time, the template engine resolves each `{{namespace.field}}` against a typed context object.
3. Missing variables throw `TemplateRenderError`. The send is queued for human review rather than going out with a `{{undefined}}`.
4. SMS templates have a max length check at render time (160 chars for single segment, 1600 for concatenated). Long sends are flagged before submission.

## Available namespaces

### `{{firm.*}}` — firm metadata

| Variable | Type | Example | Notes |
|---|---|---|---|
| `firm.name` | string | "Granite Peak CPAs" | From `firm.name` |
| `firm.address` | string | "123 Main St, Springfield, MO 65801" | Multi-line; rendered with `\n` preserved |
| `firm.phone` | string | "(417) 555-0100" | E.164 or formatted depending on `settings.phone_format` |
| `firm.email` | string | "[email protected]" | Firm's primary billing-contact email |
| `firm.website` | string | "graniepeak-cpas.com" | No protocol; templates can prepend `https://` |
| `firm.fiscal_year_start` | string | "January" | Month name from `firm.fiscal_year_start_month` |

### `{{client.*}}` — recipient client

| Variable | Type | Example | Notes |
|---|---|---|---|
| `client.name` | string | "Pinnacle Advisors LLC" | Entity name |
| `client.billing_contact_name` | string | "Lisa Tomlinson" | Primary billing contact |
| `client.billing_contact_email` | string | "lisa@pinnacle-advisors.com" | |
| `client.billing_address` | string | "456 Wacker Dr, Chicago, IL 60601" | Multi-line preserved |
| `client.terms_days` | integer | `30` | Default payment terms |
| `client.partner_in_charge_name` | string | "Sarah Chen" | Partner-in-charge from `app_user` |
| `client.partner_in_charge_email` | string | "[email protected]" | |

### `{{engagement.*}}` — engagement context

Available when a template is rendered in the context of a specific engagement.

| Variable | Type | Example | Notes |
|---|---|---|---|
| `engagement.name` | string | "2025 1120-S Tax Return" | |
| `engagement.fee_structure` | string | "Fixed fee with milestones" | Human-readable form |
| `engagement.fee_amount` | currency | "$3,250.00" | Formatted USD |
| `engagement.budget_hours` | string | "24.0 hours" | |
| `engagement.start_date` | date | "January 15, 2026" | Long-format US date |
| `engagement.end_date` | date | "April 15, 2026" | |
| `engagement.scope_definition` | string | "Preparation of federal and state 1120-S returns…" | Multi-line preserved |
| `engagement.partner_name` | string | "Sarah Chen" | |
| `engagement.manager_name` | string | "David Park" | May be empty |

### `{{invoice.*}}` — invoice context

Available when rendering invoice-related templates (sent, paid, dunning, statement).

| Variable | Type | Example | Notes |
|---|---|---|---|
| `invoice.number` | string | "INV-2026-1184" | |
| `invoice.issue_date` | date | "May 16, 2026" | |
| `invoice.due_date` | date | "June 18, 2026" | |
| `invoice.subtotal` | currency | "$5,501.00" | |
| `invoice.fees` | currency | "$385.00" | Processing fee or expense pass-through |
| `invoice.total` | currency | "$5,886.00" | |
| `invoice.paid_amount` | currency | "$0.00" | Sum of payments to date |
| `invoice.balance_due` | currency | "$5,886.00" | total − paid |
| `invoice.days_overdue` | integer | `28` | 0 if not yet due |
| `invoice.portal_url` | url | "https://portal.firm.com/invoices/abc-123" | Magic-link-aware URL to portal view |
| `invoice.pdf_url` | url | "https://app.firm.com/api/invoices/abc-123/pdf" | Requires auth |

### `{{payment.*}}` — payment context

Available when rendering payment-related templates (received, failed, refunded).

| Variable | Type | Example | Notes |
|---|---|---|---|
| `payment.amount` | currency | "$5,886.00" | |
| `payment.received_at` | date | "May 18, 2026" | |
| `payment.method_label` | string | "Visa ····3204" | Display label of the payment method |
| `payment.invoice_number` | string | "INV-2026-1184" | The invoice this payment applies to |
| `payment.confirmation_number` | string | "ch_3abc..." | Provider charge ID for client reference |

### `{{statement.*}}` — statement context

Available when rendering monthly statement / running-balance templates.

| Variable | Type | Example | Notes |
|---|---|---|---|
| `statement.period_start` | date | "April 1, 2026" | |
| `statement.period_end` | date | "April 30, 2026" | |
| `statement.opening_balance` | currency | "$2,250.00" | |
| `statement.charges` | currency | "$5,886.00" | Sum of invoices in period |
| `statement.payments` | currency | "$2,250.00" | Sum of payments in period |
| `statement.closing_balance` | currency | "$5,886.00" | |
| `statement.portal_url` | url | "https://portal.firm.com/statement" | |

### `{{portal.*}}` — portal access context

Available when rendering portal-related templates (invitation, login link, etc.).

| Variable | Type | Example | Notes |
|---|---|---|---|
| `portal.url` | url | "https://portal.firm.com" | Base portal URL |
| `portal.magic_link` | url | "https://portal.firm.com/auth/abc..." | Single-use sign-in link |
| `portal.magic_link_expires_at` | datetime | "May 18, 2026 at 3:45 PM CT" | |
| `portal.sms_code` | string | "492-851" | 6-digit OTP, formatted with separator |
| `portal.sms_code_expires_at` | datetime | "May 18, 2026 at 3:35 PM CT" | |

### `{{identity.*}}` — recipient identity (portal user)

When the template targets a `portal_identity`.

| Variable | Type | Example | Notes |
|---|---|---|---|
| `identity.full_name` | string | "Lisa Tomlinson" | |
| `identity.first_name` | string | "Lisa" | First word of full_name |
| `identity.primary_email` | string | "lisa@pinnacle-advisors.com" | |
| `identity.primary_phone` | string | "+1 (312) 555-0148" | Formatted for display |

### `{{user.*}}` — staff user recipient

When the template targets an `app_user` (internal notifications, approval requests, etc.).

| Variable | Type | Example | Notes |
|---|---|---|---|
| `user.full_name` | string | "Sarah Chen" | |
| `user.first_name` | string | "Sarah" | |
| `user.email` | string | "[email protected]" | |
| `user.role_name` | string | "Partner" | Highest-priority role assigned |

### `{{approval.*}}` — approval workflow context

Available when rendering approval-related notifications.

| Variable | Type | Example | Notes |
|---|---|---|---|
| `approval.entity_type` | string | "Adjustment" | Human-readable |
| `approval.entity_summary` | string | "$1,200 write-down on Vance Manufacturing 2025 audit" | Concise summary |
| `approval.requested_by_name` | string | "David Park" | |
| `approval.requested_at` | datetime | "May 18, 2026 at 2:30 PM CT" | |
| `approval.url` | url | "https://app.firm.com/approvals/abc-123" | Direct link, requires staff auth |
| `approval.sla_due_at` | datetime | "May 19, 2026 at 5:00 PM CT" | If SLA rule applies |

### `{{auto_pay.*}}` — auto-pay upcoming-charge context

Available for the "auto-pay scheduled 3 days ahead" notification.

| Variable | Type | Example | Notes |
|---|---|---|---|
| `auto_pay.amount` | currency | "$2,250.00" | |
| `auto_pay.charge_date` | date | "June 1, 2026" | |
| `auto_pay.payment_method_label` | string | "Visa ····3204" | |
| `auto_pay.engagement_name` | string | "Q2 advisory retainer" | |
| `auto_pay.update_url` | url | "https://portal.firm.com/methods" | Where client can update method |

## Currency formatting

All `currency`-typed variables render in USD with thousands separators and two decimal places. Examples:

- `0` → `$0.00`
- `100` → `$1.00`
- `100000` → `$1,000.00`
- `5886000` → `$58,860.00`

Currency rendering is fixed at USD per [Q2](../../QUESTIONS.md#q2--currency).

## Date formatting

Date and datetime variables render in firm-local timezone (from `office.timezone`):

- `date` type: "May 18, 2026" (long form, US)
- `datetime` type: "May 18, 2026 at 3:45 PM CT" (with timezone abbreviation)

Override the format with a helper: `{{date invoice.due_date "short"}}` produces "5/18/26". Available formats: `short`, `medium`, `long`, `iso`.

## Conditionals (limited)

To keep template logic simple and avoid the Markdown/HTML rendering surface, only **one** conditional helper is supported:

```
{{#if invoice.days_overdue}}
  Your invoice is {{invoice.days_overdue}} days overdue.
{{/if}}
```

The conditional is truthy when the variable is non-zero, non-empty-string, or non-null. No `else`, no nested conditionals, no comparisons. If a template needs more logic than this, create separate templates per scenario.

## Reserved variable names

These shadow built-in Handlebars helpers and are blocked by the variable picker:

- `this`, `each`, `with`, `unless`, `lookup`, `log`

## Adding new variables

When a build phase needs a new template variable:

1. Add the variable to the appropriate namespace section above
2. Implement it in `apps/api/src/templates/context-builder.ts` (the function that constructs the rendering context)
3. Add a unit test in `apps/api/src/templates/context-builder.test.ts`
4. Variables become available to all templates in the next deploy — no migration needed

---

# Invoice document template (Admin → Catalog → Templates → Invoice)

The **invoice document template** is separate from the notification/letter
templates above. It is the firm-wide HTML+CSS design used for every invoice
surface — staff PDF (`GET /api/invoices/:id/pdf`), the portal invoice view,
the pay-by-link PDF and the invoice email. It is edited in
**Admin → Catalog → Templates → Invoice** and stored one row per firm in
`vibetb.invoice_template`. With no saved row, the shipped default letterhead
template is used, so every firm gets the design out of the box.

Because an invoice must iterate its line items, this template uses a small
dedicated engine (`packages/core/src/invoicing/template-engine.ts`) that adds
loops and conditionals on top of `{{ token }}` substitution. This is the only
place those constructs exist — the email/SMS resolver above stays flat.

## Syntax

- `{{ scope.field }}` — value, **HTML-escaped**
- `{{{ scope.field }}}` — value, **raw HTML** (footer / dunning blocks)
- `{{ token | default("Fallback") }}` — fallback when the value is empty
- `{{#each line_items}} … {{/each}}` — iterate; inside, `{{ this.field }}`
- `{{#each surcharges}} … {{/each}}`
- `{{#if token}} … {{else}} … {{/if}}` — truthy / empty branch (nesting allowed)

CSS is stored separately and is also token-substituted, so
`--accent: {{ firm.accent_color | default("#1a1a1a") }}` works.

## Variables

### `firm.*`
- `firm.name`, `firm.logo_url`, `firm.address`, `firm.phone`, `firm.email`,
  `firm.fax`, `firm.web`, `firm.accent_color`

### `client.*`
- `client.name`, `client.address` (formatted block), `client.external_id`,
  `client.mailing_street1`, `client.mailing_street2`, `client.mailing_city`,
  `client.mailing_state`, `client.mailing_postal`, `client.mailing_country`

### `invoice.*`
- `invoice.number`, `invoice.issue_date`, `invoice.due_date`,
  `invoice.due_terms`, `invoice.reference`, `invoice.engagement_name`,
  `invoice.service_intro`, `invoice.billing_name`, `invoice.subtotal`,
  `invoice.subtotal_label`, `invoice.surcharge_total`, `invoice.tax_total`,
  `invoice.processing_fee`, `invoice.total`, `invoice.total_label`,
  `invoice.paid`, `invoice.balance_due`, `invoice.status`, `invoice.notes`
- `invoice.pay_url` — no-login pay-by-link URL (scan/click to pay without
  logging in). Populated on the staff invoice PDF when a public base URL is
  configured; empty otherwise.
- `invoice.pay_qr_src` — the QR image as a `data:` URI, for a custom
  `<img src="{{ invoice.pay_qr_src }}">`.

### `line_items[]` — inside `{{#each line_items}}`
- `this.description`, `this.amount`, `this.quantity`, `this.rate`, `this.kind`

### `surcharges[]` — inside `{{#each surcharges}}` (surcharge + tax + processing fee rows)
- `this.label`, `this.amount`

### Raw-HTML blocks — emit with `{{{ … }}}`
- `invoice.pay_qr` — a ready `<img>` QR code linking to the no-login pay page
  (use `{{#if invoice.pay_qr}} … {{{ invoice.pay_qr }}} … {{/if}}`)
- `dunning` — past-due / payment-terms notice
- `invoice_footer` — remit-to / EIN / terms footer (A/R terms win over the
  generic footer when both are set)
- `time_detail_html` — time-entry detail table (full-detail PDF mode)

## Adding new invoice variables

1. Add the field in `buildInvoiceTemplateContext` and the catalog entry in
   `INVOICE_TEMPLATE_TOKENS` (both in `packages/core/src/invoicing/context.ts`).
2. Add a unit test in `packages/core/src/invoicing/context.test.ts`.
3. The token appears in the editor's variable picker automatically.

---

# Statement document template (Admin → Catalog → Templates → Statement)

The **statement document template** is the firm-wide HTML+CSS design for the
statement of account. It uses the same template engine as the invoice document
template (loops, conditionals, `{{{ raw }}}`) and is edited in
**Admin → Catalog → Templates → Statement**, stored one row per firm in
`vibetb.statement_template`. No saved row → shipped default statement template.

It renders every statement surface: single PDF
(`GET /api/staff/statements/clients/:id`), `bulk-generate`, and `bulk-email`.

Two modes feed the same template (chosen at generation time from the client's
Billing tab, or via query params):
- **outstanding** (default): open invoices with a running balance + aging buckets.
- **activity** (`?mode=activity&start=…&end=…`): opening balance, every invoice and
  payment in the range with a running balance, and a closing balance. The
  activity-only opening/closing rows are gated on `{{#if statement.period_start}}`.

## Variables

### `firm.*` / `client.*`
Same as the invoice template (`firm.name`, `firm.logo_url`, `firm.address`,
`firm.phone`, `firm.email`, `firm.fax`, `firm.web`, `firm.accent_color`;
`client.name`, `client.address`, `client.external_id`, `client.mailing_*`).

### `statement.*`
- `statement.date` (as-of), `statement.mode` (outstanding | activity)
- `statement.period_start`, `statement.period_end` (activity mode)
- `statement.opening_balance`, `statement.charges`, `statement.payments`,
  `statement.closing_balance` (activity mode)
- `statement.total_due`

### `aging.*`
- `aging.d_0_30`, `aging.d_31_60`, `aging.d_61_90`, `aging.d_91_120`, `aging.d_121_plus`

### `lines[]` — inside `{{#each lines}}`
- `this.date`, `this.type` (Invoice/Payment), `this.reference`, `this.debit`,
  `this.credit`, `this.balance`

### Raw-HTML blocks
- `footer` — A/R terms / footer (`{{{ footer }}}`)
- `policy_notice` — banner under the table (escaped)

## Adding new statement variables
1. Add the field in `buildStatementTemplateContext` and the catalog entry in
   `STATEMENT_TEMPLATE_TOKENS` (both in `packages/core/src/invoicing/statement-context.ts`).
2. Add a unit test in `packages/core/src/invoicing/statement-context.test.ts`.
3. The token appears in the editor's variable picker automatically.
