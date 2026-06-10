// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Printable QR sheet for in-office signing. Pure function: given the document
// title and a QR data-URL per signer, returns a self-contained HTML document
// staff can print (one card per signer). The QR codes are generated
// server-side (qrcode package) and embedded as data-URLs so the sheet renders
// offline through the shared Puppeteer pipeline (pdf/render).

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface QrSheetSigner {
  name: string;
  qrDataUrl: string;
}

export interface QrSheetInput {
  firmName?: string;
  documentTitle: string;
  signers: QrSheetSigner[];
}

export function buildQrSheetHtml(input: QrSheetInput): string {
  const { firmName, documentTitle, signers } = input;
  const cards = signers
    .map(
      (s) => `
      <div class="card">
        <div class="signer">${esc(s.name)}</div>
        <img class="qr" src="${esc(s.qrDataUrl)}" alt="QR code for ${esc(s.name)}" />
        <div class="howto">Scan with your phone camera to review and sign</div>
        <div class="doc">${esc(documentTitle)}</div>
      </div>`,
    )
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Sign in office — ${esc(documentTitle)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1f2430; margin: 0; padding: 32px; font-size: 13px; line-height: 1.5; }
  .head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid #4338ca; padding-bottom: 12px; margin-bottom: 20px; }
  .head .firm { font-size: 20px; font-weight: 700; }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: #6b7280; }
  .cards { display: flex; flex-wrap: wrap; gap: 20px; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; width: 280px; text-align: center; page-break-inside: avoid; }
  .signer { font-size: 16px; font-weight: 700; margin-bottom: 12px; }
  .qr { width: 220px; height: 220px; margin: 0 auto; display: block; }
  .howto { margin-top: 12px; font-size: 12px; color: #374151; }
  .doc { margin-top: 6px; font-size: 11px; color: #6b7280; }
  @media print { body { padding: 0; } }
</style></head>
<body>
  <div class="head">
    <div class="firm">${esc(firmName ?? 'Sign in office')}</div>
    <div class="muted">${esc(documentTitle)}</div>
  </div>
  <h1>In-office signing</h1>
  <div class="muted">Hand this sheet to each signer, or have them scan their card below.</div>
  <div class="cards">${cards}</div>
</body></html>`;
}
