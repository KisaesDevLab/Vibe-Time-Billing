// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// When a signature request reaches 'completed' (reconcile), notify the firm
// (in-app staff_notifications to the request creator + the engagement's
// assignees) and confirm to the client by email (billing → primary contact,
// falling back to a signer). Both are best-effort: a notification failure
// never undoes completion. Called once — reconcile only reaches the
// 'completed' transition a single time.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientContacts,
  engagementAssignments,
  persons,
  staffNotifications,
} from '@vibe/db/schema';

import { logger } from '../logger';
import { firmScope, renderTemplate } from '../notifications/templating';
import { printNotificationChannel } from '../notifications/print-channel';
import { createFileShare } from '../sharing/file-share-helper';

/** Minimal mailer the caller wires from its provider (audit-wrapped). */
export type CompletionMailer = (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}) => Promise<void>;

/** How long the client's download link stays good. */
export const COPY_SHARE_DAYS = 30;

export interface CompletedRequestInfo {
  id: string;
  firmId: string;
  clientId: string | null;
  engagementId: string | null;
  createdBy: string | null;
  title: string;
}

/** Pick the client's confirmation email: billing contact, else primary, else
 *  any contact with an email. Returns null when the client has none. */
async function resolveClientEmail(db: Database, clientId: string): Promise<string | null> {
  const rows = await db
    .select({
      email: persons.email,
      isBilling: clientContacts.isBilling,
      isPrimary: clientContacts.isPrimary,
    })
    .from(clientContacts)
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(eq(clientContacts.clientId, clientId));
  const withEmail = rows.filter((r): r is typeof r & { email: string } => Boolean(r.email));
  if (withEmail.length === 0) return null;
  return (
    withEmail.find((r) => r.isBilling)?.email ??
    withEmail.find((r) => r.isPrimary)?.email ??
    withEmail[0]!.email
  );
}

/**
 * The sentence telling the client how to get their copy. The confirmation
 * used to say "a copy is available for your records" and stop there, which
 * left the client with no way to act on it — so this always resolves to
 * something actionable: a secure download link, or who to ask.
 *
 * A link rather than an attachment: the completion that actually fires on
 * the appliance comes from the worker's signatures-poll job, whose mail
 * dispatch carries no attachments field — so an attached PDF was silently
 * dropped on that path. The link works from either path, has no size
 * ceiling, and expires.
 */
export function copyNoteFor(args: {
  downloadUrl?: string | null;
  expiresAt?: Date | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  firmName?: string | null;
}): string {
  if (args.downloadUrl) {
    const when = args.expiresAt
      ? ` This link expires ${args.expiresAt.toISOString().slice(0, 10)}.`
      : '';
    return (
      `Download your signed copy here:\n${args.downloadUrl}\n\n` +
      `For your security the page will email you a short access code before ` +
      `the download starts.${when}`
    );
  }
  const reach = [args.supportEmail?.trim(), args.supportPhone?.trim()].filter(Boolean);
  const who = args.firmName?.trim() || 'your firm';
  return reach.length > 0
    ? `For a copy of the signed document, contact ${who} at ${reach.join(' or ')}.`
    : `For a copy of the signed document, reply to this email and ${who} will send one.`;
}

export async function notifySignatureCompleted(
  db: Database,
  request: CompletedRequestInfo,
  signerEmails: string[],
  sendEmail?: CompletionMailer,
  /** The signed PDF's file row, once reconcile has filed it into the
   *  client's folder. Drives the secure download link in the email. */
  signedFileId?: string | null,
  /** Public base URL of the portal, for the share landing page. */
  portalBaseUrl?: string | null,
): Promise<void> {
  // 1. Staff in-app notifications — the creator plus the engagement's team.
  try {
    const recipients = new Set<string>();
    if (request.createdBy) recipients.add(request.createdBy);
    if (request.engagementId) {
      const assignees = await db
        .select({ appUserId: engagementAssignments.appUserId })
        .from(engagementAssignments)
        .where(eq(engagementAssignments.engagementId, request.engagementId));
      for (const a of assignees) if (a.appUserId) recipients.add(a.appUserId);
    }
    if (recipients.size > 0) {
      await db.insert(staffNotifications).values(
        [...recipients].map((uid) => ({
          firmId: request.firmId,
          recipientAppUserId: uid,
          type: 'signature_completed',
          entityType: 'signature_request',
          entityId: request.id,
          title: 'Signatures completed',
          body: request.title,
          actionUrl: `/signatures/${request.id}`,
        })),
      );
    }
  } catch (err) {
    logger.warn({ err, requestId: request.id }, 'signature completion: staff notification failed');
  }

  // 2. Client confirmation email — best-effort, only when a mailer is wired.
  if (sendEmail && request.clientId) {
    try {
      const to = (await resolveClientEmail(db, request.clientId)) ?? signerEmails[0] ?? null;
      if (to) {
        const firm = await firmScope(db, request.firmId);
        // Mint the recipient a gated, expiring download link for the copy
        // that was just filed. Best-effort: a rate-limited or failed share
        // degrades to the "contact us" wording, never to a broken link.
        let share: { url: string; expiresAt: Date } | null = null;
        if (signedFileId && portalBaseUrl) {
          try {
            const created = await createFileShare(db, {
              firmId: request.firmId,
              clientId: request.clientId,
              fileId: signedFileId,
              createdByAppUserId: request.createdBy ?? null,
              accessLevel: 'download',
              recipientEmail: to,
              verifyChannel: 'EMAIL',
              note: `Signed copy — ${request.title}`,
              expiresAt: new Date(Date.now() + COPY_SHARE_DAYS * 86_400_000),
            });
            if (created.ok) {
              share = {
                url: `${portalBaseUrl.replace(/\/$/, '')}/shared/file/${created.token}`,
                expiresAt: created.expiresAt,
              };
            } else {
              logger.warn(
                { requestId: request.id, reason: created.error },
                'signature completion: share link not created',
              );
            }
          } catch (err) {
            logger.warn({ err, requestId: request.id }, 'signature completion: share link failed');
          }
        }
        const copyNote = copyNoteFor({
          downloadUrl: share?.url,
          expiresAt: share?.expiresAt,
          supportEmail: firm.support_email,
          supportPhone: firm.support_phone,
          firmName: firm.displayName ?? firm.name,
        });
        const fallbackSubject = `Signed: ${request.title}`;
        const fallbackBody =
          `Your documents for "${request.title}" have been signed and received by your firm. ` +
          `No further action is needed — thank you.\n\n${copyNote}`;
        const rendered = await renderTemplate({
          db,
          firmId: request.firmId,
          kind: 'signature_complete',
          channel: 'EMAIL',
          fallback: { subject: fallbackSubject, body: fallbackBody },
          context: {
            firm,
            document: { name: request.title, copy_note: copyNote },
          },
        });
        await sendEmail({
          to,
          subject: rendered.subject ?? fallbackSubject,
          body: rendered.body,
        });
      }
    } catch (err) {
      logger.warn({ err, requestId: request.id }, 'signature completion: client email failed');
    }
  }

  // 3. PRINT channel (0188) — auto-print a completion notice if configured.
  await printNotificationChannel({
    db,
    firmId: request.firmId,
    kind: 'signature_complete',
    clientId: request.clientId,
    printableId: request.id,
    context: {
      firm: await firmScope(db, request.firmId),
      document: { name: request.title },
    },
  }).catch((err) => logger.warn({ err, requestId: request.id }, 'signature print channel failed'));
}
