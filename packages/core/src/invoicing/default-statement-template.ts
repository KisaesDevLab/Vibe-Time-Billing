// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shipped default statement-of-account template. Ported from the legacy
// renderStatementHtml design into the invoice template-engine syntax so
// firms can edit it in Admin → Catalog → Templates → Statement. Until a
// firm saves an override, the statement surfaces render this body + CSS.
//
// Handles BOTH modes: outstanding (aging buckets + total due) and
// account activity (opening/closing balance over a date range). The
// activity-only pieces are gated on `{{#if statement.period_start}}`.

export const DEFAULT_STATEMENT_TEMPLATE_VERSION = '1';

export const DEFAULT_STATEMENT_BODY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Statement — {{ client.name }} — {{ statement.date }}</title>
</head>
<body>
  <div class="top-band"></div>
  <div class="header">
    <div class="logo-block">
      {{#if firm.logo_url}}<img class="logo" src="{{ firm.logo_url }}" alt="{{ firm.name }}">{{else}}<h1>{{ firm.name }}</h1>{{/if}}
    </div>
    <div class="pills">
      {{#if firm.phone}}<div class="pill"><span class="ic">☎</span><span>{{ firm.phone }}</span></div>{{/if}}
      {{#if firm.email}}<div class="pill"><span class="ic">✉</span><span>{{ firm.email }}</span></div>{{/if}}
      {{#if firm.web}}<div class="pill"><span class="ic">⟗</span><span>{{ firm.web }}</span></div>{{/if}}
    </div>
  </div>
  {{#if firm.address}}<div class="firm-strip">📍 {{ firm.address }}</div>{{/if}}

  <div class="recipient">
    <div class="addr">
      <div class="name">{{ client.name }}</div>
      {{#if client.address}}<div class="caddr">{{ client.address }}</div>{{/if}}
    </div>
    <div class="meta">
      <div class="row"><span class="lbl">Date:</span><span>{{ statement.date }}</span></div>
      {{#if client.external_id}}<div class="row"><span class="lbl">ID:</span><span>{{ client.external_id }}</span></div>{{/if}}
      {{#if statement.period_start}}<div class="row"><span class="lbl">Period:</span><span>{{ statement.period_start }} – {{ statement.period_end }}</span></div>{{/if}}
    </div>
  </div>

  <div class="doc-title">Statement of Account</div>

  <table class="ledger">
    <thead>
      <tr>
        <th>Date</th>
        <th>Type</th>
        <th>Reference</th>
        <th class="num">Debit</th>
        <th class="num">Credit</th>
        <th class="num">Balance</th>
      </tr>
    </thead>
    <tbody>
      {{#if statement.period_start}}
      <tr class="opening">
        <td>{{ statement.period_start }}</td>
        <td colspan="2">Opening balance</td>
        <td class="num"></td>
        <td class="num"></td>
        <td class="num">{{ statement.opening_balance }}</td>
      </tr>
      {{/if}}
      {{#each lines}}
      <tr>
        <td>{{ this.date }}</td>
        <td>{{ this.type }}</td>
        <td>{{ this.reference }}</td>
        <td class="num">{{ this.debit }}</td>
        <td class="num">{{ this.credit }}</td>
        <td class="num">{{ this.balance }}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  {{#if statement.period_start}}
  <div class="total-row">
    <div class="date">{{ statement.period_end }}</div>
    <div class="label">Closing Balance</div>
    <div class="amt">{{ statement.closing_balance }}</div>
  </div>
  {{else}}
  <div class="total-row">
    <div class="date">{{ statement.date }}</div>
    <div class="label">Total Amount Due</div>
    <div class="amt">{{ statement.total_due }}</div>
  </div>
  {{/if}}

  {{#if policy_notice}}<div class="policy">{{ policy_notice }}</div>{{/if}}

  <div class="aging">
    <div class="bucket"><div class="lbl">0-30 Days</div><div class="amt">{{ aging.d_0_30 }}</div></div>
    <div class="bucket"><div class="lbl">31-60 Days</div><div class="amt">{{ aging.d_31_60 }}</div></div>
    <div class="bucket"><div class="lbl">61-90 Days</div><div class="amt">{{ aging.d_61_90 }}</div></div>
    <div class="bucket"><div class="lbl">91-120 Days</div><div class="amt">{{ aging.d_91_120 }}</div></div>
    <div class="bucket"><div class="lbl">121+ Days</div><div class="amt">{{ aging.d_121_plus }}</div></div>
    <div class="bucket total"><div class="lbl">Total</div><div class="amt">{{ statement.total_due }}</div></div>
  </div>

  {{#if footer}}<div class="terms">{{{ footer }}}</div>{{/if}}
</body>
</html>`;

export const DEFAULT_STATEMENT_CSS = `@page { size: Letter; margin: 0.5in; }
body {
  font: 11pt "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #111;
  margin: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.top-band { height: 6px; background: #000; }
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  padding: 18px 0 0;
}
.logo-block { display: flex; flex-direction: column; }
.logo-block .logo { max-height: 70px; max-width: 320px; object-fit: contain; }
.logo-block h1 {
  font-size: 28pt;
  margin: 0;
  letter-spacing: -0.02em;
  color: #111;
  font-weight: 800;
}
.pills { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
.pill {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 12px;
  background: {{ firm.accent_color | default("#111") }};
  color: #fff;
  font-size: 10.5pt;
  font-weight: 600;
  border-radius: 1px;
}
.pill .ic { width: 16px; text-align: center; font-size: 11pt; }
.firm-strip {
  margin-top: 6px;
  padding: 5px 14px;
  background: {{ firm.accent_color | default("#111") }};
  color: #fff;
  font-size: 10pt;
  text-align: right;
}
.recipient {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 24px;
  margin-top: 32px;
  font-size: 11pt;
  line-height: 1.45;
}
.recipient .addr { font-weight: 500; }
.recipient .addr .name { font-weight: 700; margin-bottom: 2px; }
.recipient .addr .caddr { white-space: pre-line; }
.recipient .meta { font-size: 11pt; }
.recipient .meta .row { display: flex; gap: 8px; margin-bottom: 4px; }
.recipient .meta .row .lbl { color: #555; min-width: 50px; }
.doc-title {
  text-align: center;
  font-style: italic;
  font-size: 16pt;
  margin: 32px 0 12px;
  border-top: 1px solid #888;
  padding-top: 14px;
}
table.ledger { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
table.ledger th {
  text-align: left;
  padding: 4px 8px;
  font-weight: 600;
  font-style: italic;
  color: #333;
}
table.ledger th.num { text-align: right; }
table.ledger td { padding: 6px 8px; vertical-align: top; }
table.ledger td.num { text-align: right; font-variant-numeric: tabular-nums; }
table.ledger tr.opening td { font-style: italic; color: #444; }
.total-row {
  margin-top: 8px;
  border-top: 1px solid #000;
  padding-top: 6px;
  display: grid;
  grid-template-columns: 90px 1fr auto;
  font-size: 11pt;
}
.total-row .date { padding: 0 8px; }
.total-row .label { font-weight: 600; }
.total-row .amt {
  border-bottom: 2px solid #000;
  padding: 0 8px 4px;
  min-width: 120px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}
.policy { margin-top: 48px; text-align: center; font-weight: 700; font-size: 11pt; }
.aging {
  margin-top: 20px;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  border-top: 1px solid #000;
  padding-top: 8px;
  font-size: 10.5pt;
}
.aging .bucket { text-align: center; }
.aging .bucket .lbl { text-decoration: underline; margin-bottom: 4px; font-weight: 500; }
.aging .bucket .amt { font-variant-numeric: tabular-nums; }
.aging .bucket.total .amt { font-weight: 700; }
.terms {
  margin-top: 36px;
  padding-top: 12px;
  border-top: 1px solid #ccc;
  font-size: 9pt;
  font-style: italic;
  color: #555;
  white-space: pre-wrap;
}`;
