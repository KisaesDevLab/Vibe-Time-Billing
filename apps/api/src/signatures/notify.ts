// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Signer notification. OpenSign's createdocumentfromapp does NOT email
// signers — document creation is silent (confirmed against the deployed
// instance; the proposal flow likewise delivers links itself). So WE must
// deliver each signer their per-signer signing URL, or nobody ever signs.
//
// Parallel sends notify every signer at once; sequential sends notify the
// first signer here and the next signer from reconcile as each one
// completes. All sends are best-effort (a mail failure never rolls back a
// committed send — the link is also visible to staff on the detail page).

export type SignerMailer = (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
}) => Promise<void>;

export interface SignerNotice {
  to: string;
  name: string;
  title: string;
  signingUrl: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildSignerEmail(n: SignerNotice): { subject: string; body: string; html: string } {
  const subject = `Signature requested: ${n.title}`;
  const body =
    `Hello ${n.name},\n\n` +
    `You have a document to review and sign: "${n.title}".\n\n` +
    `Open it here to sign:\n${n.signingUrl}\n\n` +
    `If you did not expect this, you can ignore this message.`;
  const html =
    `<p>Hello ${escapeHtml(n.name)},</p>` +
    `<p>You have a document to review and sign: <strong>${escapeHtml(n.title)}</strong>.</p>` +
    `<p><a href="${escapeHtml(n.signingUrl)}">Open the document to sign</a></p>` +
    `<p style="color:#888;font-size:12px">If you did not expect this, you can ignore this message.</p>`;
  return { subject, body, html };
}

/** Best-effort: email one signer; never throws. Returns true on success. */
export async function notifySigner(mailer: SignerMailer, notice: SignerNotice): Promise<boolean> {
  const mail = buildSignerEmail(notice);
  try {
    await mailer({ to: notice.to, subject: mail.subject, body: mail.body, html: mail.html });
    return true;
  } catch {
    return false;
  }
}

/** OpenSign UI signing route for a (document, contact). Matches the URL the
 *  provider builds for proposals. */
export function signerSigningUrl(publicUrl: string, documentId: string, contactId: string): string {
  return `${publicUrl}/load/recipientSignPdf/${documentId}/${contactId}`;
}
