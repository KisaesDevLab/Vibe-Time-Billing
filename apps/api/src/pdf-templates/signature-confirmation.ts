// SPDX-License-Identifier: Elastic-2.0
//
// Signature confirmation report — printed automatically when a tax-return
// signature request completes. Pure function: given the request + signer
// data, returns a self-contained HTML document for the shared Puppeteer
// pipeline (pdf/render). Summarizes who signed and when; the full audit
// certificate (signer IP, hashes, event trail) remains on file separately.

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (m) return `${m[2]}/${m[3]}/${m[1]} ${m[4]}:${m[5]}`;
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return d ? `${d[2]}/${d[3]}/${d[1]}` : iso;
}

export interface SignatureConfirmationSigner {
  name: string;
  email?: string | null;
  signedAt?: string | null;
}

export interface SignatureConfirmationInput {
  firmName: string;
  documentTitle: string;
  formType?: string | null;
  clientName?: string | null;
  completedAt?: string | null;
  certificateAvailable?: boolean;
  signers: SignatureConfirmationSigner[];
}

export function renderSignatureConfirmationHtml(input: SignatureConfirmationInput): string {
  const rows = input.signers
    .map(
      (s) => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.email ?? '')}</td>
        <td>${esc(fmtDateTime(s.signedAt))}</td>
      </tr>`,
    )
    .join('');

  const metaRow = (label: string, value: string): string =>
    value
      ? `<div class="row"><span class="lbl">${esc(label)}</span><span>${esc(value)}</span></div>`
      : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Signature Confirmation — ${esc(input.documentTitle)}</title>
<style>
  @page { size: Letter; margin: 0.6in; }
  body { font: 11pt "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid #111; padding-bottom: 12px; }
  .firm { font-size: 18pt; font-weight: 800; }
  h1 { font-size: 15pt; margin: 24px 0 6px; }
  .meta { font-size: 11pt; line-height: 1.6; margin: 8px 0 18px; }
  .meta .row { display: flex; gap: 10px; }
  .meta .lbl { color: #555; min-width: 130px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5pt; margin-top: 6px; }
  th { text-align: left; border-bottom: 2px solid #333; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .note { margin-top: 28px; font-size: 9.5pt; color: #555; font-style: italic; }
</style></head>
<body>
  <div class="head">
    <div class="firm">${esc(input.firmName)}</div>
    <div>Signature Confirmation</div>
  </div>

  <h1>Document signed</h1>
  <div class="meta">
    ${metaRow('Document', input.documentTitle)}
    ${metaRow('Form type', input.formType ?? '')}
    ${metaRow('Client', input.clientName ?? '')}
    ${metaRow('Completed', fmtDateTime(input.completedAt))}
  </div>

  <table>
    <thead><tr><th>Signer</th><th>Email</th><th>Signed at</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="note">
    This confirmation summarizes the completed signature. ${
      input.certificateAvailable
        ? 'The full audit certificate (signer IP, document hash, and event trail) is retained on file.'
        : ''
    }
  </div>
</body></html>`;
}
