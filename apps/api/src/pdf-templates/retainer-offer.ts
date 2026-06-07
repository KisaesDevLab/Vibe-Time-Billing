// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Printable / PDF HTML for the proposal-style retainer offer. Pure function:
// given the presentation data, returns a self-contained HTML document staff can
// print or hand to a client (browser print-to-PDF, or Puppeteer via pdf/render).
//
// Mirrors the three-option presentation: tax return only / return + Standard /
// return + Premium. The return-only option is omitted when the return is paid.

import type { RetainerOfferPresentation } from '../retainers/offer-presentation';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Minimal, dependency-free Markdown → HTML for the firm-authored intro/terms.
// Supports headings, bold/italic, links, unordered/ordered lists, paragraphs.
function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      closeList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = Math.min(6, h[1]!.length);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1]!)}</li>`);
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[1]!)}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

export function renderRetainerOfferHtml(p: RetainerOfferPresentation): string {
  const accent =
    p.branding.accentColor && /^#[0-9a-fA-F]{3,8}$/.test(p.branding.accentColor)
      ? p.branding.accentColor
      : '#4338ca';
  const returnPaid = p.returnInvoice.returnPaid;

  // Build the option cards. Card 1 (return only) is dropped once paid.
  const cards: string[] = [];
  if (!returnPaid) {
    cards.push(`
      <div class="card">
        <div class="card-head"><span class="opt">Option 1</span><h3>Tax return only</h3></div>
        <div class="price">${money(p.returnInvoice.totalCents)}</div>
        <p class="muted">Preparation and filing of your TY${p.offer.taxYear} ${esc(p.offer.returnType)} return.</p>
      </div>`);
  }
  p.tiers.forEach((t, i) => {
    const optNum = returnPaid ? i + 1 : i + 2;
    const price = returnPaid ? t.retainerPriceCents : t.bundledPriceCents;
    const heading = returnPaid
      ? `${esc(t.name)} representation`
      : `Tax return + ${esc(t.name)} representation`;
    cards.push(`
      <div class="card${t.tier === 'TIER_2' ? ' featured' : ''}">
        <div class="card-head"><span class="opt">Option ${optNum}</span><h3>${heading}</h3></div>
        <div class="price">${money(price)}</div>
        ${returnPaid ? `<p class="muted">Add-on to your already-paid return.</p>` : ''}
        <p class="muted">${t.hours} prepaid representation hour${t.hours === 1 ? '' : 's'} (notices &amp; audits).</p>
        ${t.description ? `<div class="desc">${mdToHtml(t.description)}</div>` : ''}
      </div>`);
  });

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Tax Representation Offer — ${esc(p.client.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1f2430; margin: 0; padding: 32px; font-size: 13px; line-height: 1.5; }
  .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid ${accent}; padding-bottom: 12px; margin-bottom: 20px; }
  .head img { max-height: 56px; }
  .head .firm { font-size: 20px; font-weight: 700; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  h3 { font-size: 15px; margin: 0; }
  .muted { color: #6b7280; }
  .intro { margin: 12px 0 20px; }
  .cards { display: grid; grid-template-columns: repeat(${cards.length}, 1fr); gap: 14px; }
  .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; }
  .card.featured { border-color: ${accent}; box-shadow: 0 0 0 1px ${accent}; }
  .card-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
  .opt { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: ${accent}; font-weight: 700; }
  .price { font-size: 24px; font-weight: 700; margin: 6px 0; }
  .desc { font-size: 12px; }
  .terms { margin-top: 24px; font-size: 12px; color: #374151; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  .howto { margin-top: 20px; background: #f8f9fc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; font-size: 12px; }
  @media print { body { padding: 0; } }
</style></head>
<body>
  <div class="head">
    ${p.branding.logoUrl ? `<img src="${esc(p.branding.logoUrl)}" alt="${esc(p.branding.firmName)}" />` : `<div class="firm">${esc(p.branding.firmName)}</div>`}
    <div class="muted">TY${p.offer.taxYear} ${esc(p.offer.returnType)}</div>
  </div>

  <h1>Tax Representation Retainer</h1>
  <div class="muted">Prepared for ${esc(p.client.name)}</div>

  ${p.introMd ? `<div class="intro">${mdToHtml(p.introMd)}</div>` : ''}

  <h2>Choose your coverage</h2>
  <div class="cards">${cards.join('')}</div>

  <div class="howto">
    <strong>How to accept:</strong> select an option and pay online through your secure client
    portal, or bring this sheet to our office and pay by cash or check. A prepaid retainer lets us
    handle IRS or state notices and audit support without per-hour billing surprises; unused hours
    expire three years after the return due date.
  </div>

  ${p.termsMd ? `<div class="terms">${mdToHtml(p.termsMd)}</div>` : ''}
</body></html>`;
}
