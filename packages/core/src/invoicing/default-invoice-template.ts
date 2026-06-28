// SPDX-License-Identifier: Elastic-2.0
//
// The shipped default invoice document template — a CPA letterhead
// layout (logo + business block, client/meta header, indented charge
// rows, double-rule total, dunning notice, fine-print footer). Authored
// in the invoice template-engine syntax ({{ token }}, {{#each}},
// {{#if}}, |default, {{{ raw }}}). Firms can edit this in
// Admin → Catalog → Templates → Invoice; until they save an override,
// `composeInvoiceHtml` renders this body + CSS so every firm gets the
// new design immediately.
//
// Bump DEFAULT_INVOICE_TEMPLATE_VERSION when the shipped default
// changes, so the editor can offer "reset to latest default".

export const DEFAULT_INVOICE_TEMPLATE_VERSION = '1';

export const DEFAULT_INVOICE_BODY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice {{ invoice.number }}</title>
</head>
<body>
<div class="page">

  <!-- ============ LETTERHEAD ============ -->
  <div class="letterhead">
    {{#if firm.logo_url}}
    <div class="logo"><img src="{{ firm.logo_url }}" alt="{{ firm.name }}"></div>
    {{/if}}
    <div class="biz">
      <div class="biz-name">{{ firm.name }}</div>
      {{#if firm.address}}<div class="biz-addr">{{ firm.address }}</div>{{/if}}
    </div>
  </div>

  <!-- ============ INVOICE HEADER ============ -->
  <div class="header-grid">
    <div class="client">
      {{#if client.name}}<div class="cname">{{ client.name }}</div>{{/if}}
      {{#if client.address}}<div class="caddr">{{ client.address }}</div>{{/if}}
    </div>
    <div class="meta">
      {{#if client.external_id}}<div class="row"><span class="label">ID:</span><span>{{ client.external_id }}</span></div>{{/if}}
      <div class="row"><span class="label">Invoice:</span><span>{{ invoice.number }}</span></div>
      <div class="row"><span class="label">Date:</span><span>{{ invoice.issue_date }}</span></div>
      <div class="row"><span class="label">Due:</span><span>{{ invoice.due_terms | default("Due Upon Receipt") }}</span></div>
    </div>
  </div>

  <hr class="rule">

  <!-- ============ SERVICE / CHARGES ============ -->
  <div class="svc-intro">{{ invoice.service_intro | default("For professional service rendered as follows:") }}</div>
  {{#if invoice.billing_name}}<div class="svc-client">{{ invoice.billing_name }}</div>{{/if}}

  <div class="charges">
    {{#each line_items}}
    <div class="charge-row detail">
      <span class="desc">{{ this.description }}</span>
      <span class="amt">{{ this.amount }}</span>
    </div>
    {{/each}}

    {{#if invoice.subtotal}}
    <div class="charge-row">
      <span class="desc">{{ invoice.subtotal_label | default("Billed Time and Expenses") }}</span>
      <span class="amt">{{ invoice.subtotal }}</span>
    </div>
    {{/if}}

    {{#each surcharges}}
    <div class="charge-row">
      <span class="desc">{{ this.label }}</span>
      <span class="amt">{{ this.amount }}</span>
    </div>
    {{/each}}

    <div class="charge-row total">
      <span class="desc">{{ invoice.total_label | default("Total Current Charges") }}</span>
      <span class="amt">{{ invoice.total }}</span>
    </div>
  </div>

  {{#if time_detail_html}}<div class="time-detail">{{{ time_detail_html }}}</div>{{/if}}

  <div class="spacer"></div>

  <!-- ============ BOTTOM: pay QR + dunning + footer ============ -->
  <div class="bottom">
    {{#if invoice.pay_qr}}
    <div class="paybox">
      <div class="payqr">{{{ invoice.pay_qr }}}</div>
      <div class="paymsg">
        <strong>Scan to pay online</strong><br>
        No login required.<br>
        <span class="payurl">{{ invoice.pay_url }}</span>
      </div>
    </div>
    {{/if}}
    {{#if dunning}}<div class="dunning">{{{ dunning }}}</div>{{/if}}
    {{#if invoice_footer}}<div class="invoice-footer">{{{ invoice_footer }}}</div>{{/if}}
  </div>

</div>
</body>
</html>`;

export const DEFAULT_INVOICE_CSS = `:root {
  --accent: {{ firm.accent_color | default("#1a1a1a") }};
  --ink:    #222;
  --rule:   #000;
}

* { box-sizing: border-box; }

html, body {
  margin: 0; padding: 0;
  background: #e9e9e9;
  font-family: "Times New Roman", Georgia, serif;
  color: var(--ink);
}

.page {
  width: 8.5in;
  min-height: 11in;
  margin: 24px auto;
  padding: 0.6in 0.6in 0.5in;
  background: #fff;
  box-shadow: 0 2px 14px rgba(0,0,0,.25);
  display: flex;
  flex-direction: column;
}

/* ---------- LETTERHEAD ---------- */
.letterhead {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--accent);
}
.letterhead .logo img {
  max-height: 90px;
  max-width: 230px;
  display: block;
}
.letterhead .biz { padding-top: 2px; }
.biz .biz-name {
  font-family: Arial, Helvetica, sans-serif;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -.2px;
  color: var(--accent);
  line-height: 1.1;
}
.biz .biz-addr {
  font-size: 12px;
  line-height: 1.4;
  margin-top: 4px;
  white-space: pre-line;
}

/* ---------- INVOICE HEADER ---------- */
.header-grid {
  display: flex;
  justify-content: space-between;
  gap: 30px;
  padding: 16px 0 12px;
}
.client { font-size: 14px; line-height: 1.4; }
.client .caddr { white-space: pre-line; }

.meta { font-size: 14px; line-height: 1.5; min-width: 240px; }
.meta .row { display: flex; gap: 10px; }
.meta .label { width: 60px; }

hr.rule { border: none; border-top: 1px solid var(--rule); margin: 0 0 6px; }

/* ---------- SERVICE / CHARGES ---------- */
.svc-intro  { font-size: 14px; margin-bottom: 4px; }
.svc-client { font-size: 14px; margin: 2px 0 12px; }

.charges { font-size: 14px; }
.charge-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 3px 0;
}
.charge-row .desc { padding-right: 24px; }
.charge-row.detail .desc { padding-left: 28px; }
.charge-row .amt {
  min-width: 110px;
  text-align: right;
  border-bottom: 1px solid #000;
  padding-bottom: 1px;
  white-space: nowrap;
}
.charge-row.total .amt {
  border-top: 1px solid #000;
  border-bottom: 3px double #000;
}

.time-detail { font-size: 11px; margin-top: 18px; }

/* ---------- spacer ---------- */
.spacer { flex: 1 1 auto; min-height: 40px; }

/* ---------- BOTTOM ---------- */
.bottom { margin-top: auto; }
.paybox {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 0 14px;
  margin-bottom: 12px;
  border-bottom: 1px solid #ccc;
}
.paybox .payqr img { display: block; width: 110px; height: 110px; }
.paybox .paymsg { font-size: 12px; line-height: 1.5; }
.paybox .paymsg .payurl { font-size: 10px; color: #555; word-break: break-all; }
.dunning {
  font-size: 13px;
  line-height: 1.4;
  font-weight: 700;
  margin-bottom: 14px;
}
.invoice-footer {
  font-size: 10px;
  line-height: 1.4;
  color: #333;
}
.invoice-footer .terms { font-style: italic; }

/* ---------- print ---------- */
@media print {
  html, body { background: #fff; }
  .page { margin: 0; box-shadow: none; width: auto; min-height: auto; }
  @page { size: letter; margin: 0.5in; }
}`;
