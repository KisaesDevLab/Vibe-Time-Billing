// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
//
// 0231 — the request's notifyChannel picks email, text, or both. A text
// carries the same per-signer URL; the signing page itself is the gate,
// so SMS adds no exposure the emailed link doesn't already have.

import type { Database } from '@vibe/db';
import { firms } from '@vibe/db/schema';
import { normalizePhone } from '@vibe/core/auth';

import { firmScope, renderTemplate } from '../notifications/templating';

export type SignerMailer = (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
}) => Promise<void>;

export type SignerTexter = (args: { to: string; body: string }) => Promise<void>;

/** How a request's signing links go out. Mirrors signature_requests.notify_channel. */
export type NotifyChannel = 'EMAIL' | 'SMS' | 'BOTH';

export function wantsEmail(channel: NotifyChannel): boolean {
  return channel !== 'SMS';
}
export function wantsSms(channel: NotifyChannel): boolean {
  return channel !== 'EMAIL';
}

export interface SignerNotice {
  to: string;
  name: string;
  title: string;
  signingUrl: string;
  /** E.164-able phone; required to text this signer. */
  phone?: string | null;
  /** When supplied, the email subject/body honor the firm's
   *  `signature_request` template override; otherwise the inline copy is used. */
  db?: Database | null;
  firmId?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function buildSignerEmail(
  n: SignerNotice,
): Promise<{ subject: string; body: string; html: string }> {
  const fallbackSubject = `Signature requested: ${n.title}`;
  const fallbackBody =
    `Hello ${n.name},\n\n` +
    `You have a document to review and sign: "${n.title}".\n\n` +
    `Open it here to sign:\n${n.signingUrl}\n\n` +
    `If you did not expect this, you can ignore this message.`;
  let subject = fallbackSubject;
  let body = fallbackBody;
  if (n.db) {
    let firmId = n.firmId;
    if (!firmId) {
      const [firm] = await n.db.select({ id: firms.id }).from(firms).limit(1);
      firmId = firm?.id;
    }
    if (firmId) {
      const rendered = await renderTemplate({
        db: n.db,
        firmId,
        kind: 'signature_request',
        channel: 'EMAIL',
        fallback: { subject: fallbackSubject, body: fallbackBody },
        context: {
          client: { name: n.name },
          firm: await firmScope(n.db, firmId),
          document: { name: n.title },
          link: { url: n.signingUrl },
        },
      });
      subject = rendered.subject ?? fallbackSubject;
      body = rendered.body;
    }
  }
  const html =
    `<p>Hello ${escapeHtml(n.name)},</p>` +
    `<p>You have a document to review and sign: <strong>${escapeHtml(n.title)}</strong>.</p>` +
    `<p><a href="${escapeHtml(n.signingUrl)}">Open the document to sign</a></p>` +
    `<p style="color:#888;font-size:12px">If you did not expect this, you can ignore this message.</p>`;
  return { subject, body, html };
}

/** Best-effort: email one signer; never throws. Returns true on success. */
export async function notifySigner(mailer: SignerMailer, notice: SignerNotice): Promise<boolean> {
  const mail = await buildSignerEmail(notice);
  try {
    await mailer({ to: notice.to, subject: mail.subject, body: mail.body, html: mail.html });
    return true;
  } catch {
    return false;
  }
}

/** SMS copy for one signer — one line plus the link, honoring the firm's
 *  `signature_request` SMS template when it has one. */
export async function buildSignerSms(n: SignerNotice): Promise<string> {
  const fallbackBody = `${n.name}, you have a document to sign: "${n.title}". Sign here: ${n.signingUrl}`;
  if (!n.db) return fallbackBody;
  let firmId = n.firmId;
  if (!firmId) {
    const [firm] = await n.db.select({ id: firms.id }).from(firms).limit(1);
    firmId = firm?.id;
  }
  if (!firmId) return fallbackBody;
  const rendered = await renderTemplate({
    db: n.db,
    firmId,
    kind: 'signature_request',
    channel: 'SMS',
    fallback: { body: fallbackBody },
    context: {
      client: { name: n.name },
      firm: await firmScope(n.db, firmId),
      document: { name: n.title },
      link: { url: n.signingUrl },
    },
  });
  return rendered.body;
}

/**
 * Best-effort: text one signer their link; never throws. Returns false
 * when the signer has no usable number — the caller reports that as an
 * un-notified signer rather than failing the send.
 */
export async function notifySignerSms(
  texter: SignerTexter,
  notice: SignerNotice,
): Promise<boolean> {
  const to = notice.phone ? normalizePhone(notice.phone) : null;
  if (!to) return false;
  try {
    await texter({ to, body: await buildSignerSms(notice) });
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
