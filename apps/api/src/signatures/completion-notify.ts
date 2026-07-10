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

/** Minimal mailer the caller wires from its provider (audit-wrapped). */
export type CompletionMailer = (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
}) => Promise<void>;

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

export async function notifySignatureCompleted(
  db: Database,
  request: CompletedRequestInfo,
  signerEmails: string[],
  sendEmail?: CompletionMailer,
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
        const fallbackSubject = `Signed: ${request.title}`;
        const fallbackBody = `Your documents for "${request.title}" have been signed and received by your firm. No further action is needed — thank you.`;
        const rendered = await renderTemplate({
          db,
          firmId: request.firmId,
          kind: 'signature_complete',
          channel: 'EMAIL',
          fallback: { subject: fallbackSubject, body: fallbackBody },
          context: {
            firm: await firmScope(db, request.firmId),
            document: { name: request.title },
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
