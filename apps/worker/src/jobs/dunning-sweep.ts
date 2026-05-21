// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Dunning sweep: walks invoices with status SENT/PARTIALLY_PAID/OVERDUE
// whose due_date is past today and emits the dunning steps that haven't
// already fired (recorded in a per-invoice ledger key on Redis or — in
// future — a dunning_history table).

import { and, eq, inArray, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  auditLog,
  clientCommunications,
  clientContacts,
  clients,
  dunningHistory,
  engagements,
  invoices,
} from '@vibe/db/schema';
import { stepsDueOn, type DunningStepKind } from '@vibe/core/dunning';

import type { Logger } from 'pino';

export interface DunningSweepDeps {
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
  portalBaseUrl?: string;
}

const SUBJECT_BY_KIND: Record<DunningStepKind, string> = {
  REMINDER_FRIENDLY: 'Friendly reminder: invoice past due',
  REMINDER_FIRM: 'Past due notice',
  REMINDER_ESCALATED: 'Urgent: invoice significantly past due',
  PARTNER_NOTIFY: 'Past due — partner escalation',
  AUTO_PAUSE: 'Service pause notice',
};

export async function runDunningSweep(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
  deps: DunningSweepDeps = {},
): Promise<{ scanned: number; stepsFired: number; sentEmails: number; sentSms: number }> {
  const overdue = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      dueDate: invoices.dueDate,
      status: invoices.status,
      totalCents: invoices.totalCents,
      paidCents: invoices.paidCents,
      clientId: invoices.clientId,
      clientName: clients.name,
      // v2 0027 — billing email/phone live on client_contact (isBilling).
      billingContactEmail: clientContacts.email,
      billingContactPhone: clientContacts.phone,
      primaryEngagementId: invoices.primaryEngagementId,
      firmId: invoices.firmId,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(
      clientContacts,
      and(eq(clientContacts.clientId, clients.id), eq(clientContacts.isBilling, true)),
    )
    .where(
      and(
        inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
        lte(invoices.dueDate, today),
      ),
    )
    .limit(500);

  let stepsFired = 0;
  let sentEmails = 0;
  let sentSms = 0;
  for (const inv of overdue) {
    const alreadyRows = await db
      .select({ stepKind: dunningHistory.stepKind })
      .from(dunningHistory)
      .where(eq(dunningHistory.invoiceId, inv.id));
    const alreadySentKinds = new Set<DunningStepKind>(
      alreadyRows.map((r) => r.stepKind as DunningStepKind),
    );
    const due = stepsDueOn({ invoiceDueDate: inv.dueDate, today, alreadySentKinds });
    for (const step of due) {
      stepsFired++;
      const balance = Number(inv.totalCents) - Number(inv.paidCents);
      const link = deps.portalBaseUrl ? `${deps.portalBaseUrl}/invoices/${inv.id}` : '';
      const body =
        `Invoice ${inv.invoiceNumber} (balance $${(balance / 100).toFixed(2)}) ` +
        `was due ${inv.dueDate}.` +
        (link ? `\n\nView/pay: ${link}` : '');
      let outcome = 'SENT';
      let errorMessage: string | null = null;
      let channel: 'EMAIL' | 'SMS' | null = null;
      let recipient: string | null = null;
      const subject = SUBJECT_BY_KIND[step.kind];
      if (deps.sendEmail && inv.billingContactEmail) {
        channel = 'EMAIL';
        recipient = inv.billingContactEmail;
        try {
          await deps.sendEmail({ to: inv.billingContactEmail, subject, body });
          sentEmails++;
          // v2 followup — record dunning email in client timeline.
          await db
            .insert(clientCommunications)
            .values({
              firmId: inv.firmId,
              clientId: inv.clientId,
              channel: 'EMAIL',
              direction: 'OUTBOUND',
              subject,
              body,
              occurredAt: new Date(),
              relatedEntityType: 'dunning',
              relatedEntityId: inv.id,
            })
            .catch(() => undefined);
        } catch (err) {
          outcome = 'FAILED';
          errorMessage = err instanceof Error ? err.message : 'send_failed';
          log.error({ err, invoiceId: inv.id, step: step.kind }, 'dunning email failed');
        }
      } else if (deps.sendSms && inv.billingContactPhone) {
        channel = 'SMS';
        recipient = inv.billingContactPhone;
        const smsBody = `${subject}: ${inv.invoiceNumber} ($${(balance / 100).toFixed(
          2,
        )}) due ${inv.dueDate}.${link ? ` ${link}` : ''}`;
        try {
          await deps.sendSms({ to: inv.billingContactPhone, body: smsBody });
          sentSms++;
          await db
            .insert(clientCommunications)
            .values({
              firmId: inv.firmId,
              clientId: inv.clientId,
              channel: 'SMS',
              direction: 'OUTBOUND',
              subject: null,
              body: smsBody,
              occurredAt: new Date(),
              relatedEntityType: 'dunning',
              relatedEntityId: inv.id,
            })
            .catch(() => undefined);
        } catch (err) {
          outcome = 'FAILED';
          errorMessage = err instanceof Error ? err.message : 'send_failed';
          log.error({ err, invoiceId: inv.id, step: step.kind }, 'dunning sms failed');
        }
      } else {
        outcome = 'NO_DISPATCHER';
        log.info(
          { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, step: step.kind },
          'dunning step due (no dispatcher)',
        );
      }
      // Record the step. Unique index on (invoice_id, step_kind) makes
      // double-firing the same step a no-op (insert with ON CONFLICT DO NOTHING).
      try {
        await db
          .insert(dunningHistory)
          .values({
            invoiceId: inv.id,
            stepKind: step.kind,
            channel,
            recipient,
            outcome,
            errorMessage,
          })
          .onConflictDoNothing();
      } catch (err) {
        log.error({ err, invoiceId: inv.id, step: step.kind }, 'dunning ledger write failed');
      }
      // Phase 15 #11 — PARTNER_NOTIFY: also send to the engagement's
      // partner-in-charge (not just the client billing contact). The
      // primary engagement on the invoice points us at the partner.
      if (step.kind === 'PARTNER_NOTIFY' && deps.sendEmail && inv.primaryEngagementId) {
        try {
          const [partner] = await db
            .select({ email: appUsers.email, fullName: appUsers.fullName })
            .from(engagements)
            .innerJoin(appUsers, eq(appUsers.id, engagements.partnerId))
            .where(eq(engagements.id, inv.primaryEngagementId))
            .limit(1);
          if (partner?.email) {
            await deps.sendEmail({
              to: partner.email,
              subject: `Partner escalation: ${inv.clientName} ${inv.invoiceNumber} past due`,
              body: [
                `Hi ${partner.fullName ?? 'there'},`,
                ``,
                `An invoice on one of your engagements is now significantly past due:`,
                `  Client: ${inv.clientName}`,
                `  Invoice: ${inv.invoiceNumber}`,
                `  Balance: $${(balance / 100).toFixed(2)}`,
                `  Due date: ${inv.dueDate}`,
                ``,
                `Standard dunning has run; consider personal outreach.`,
              ].join('\n'),
            });
          }
        } catch (err) {
          log.warn({ err, invoiceId: inv.id }, 'partner notify dispatch failed');
        }
      }
      // Phase 15 #12 — AUTO_PAUSE: flip the engagement to PAUSED so no
      // new time entries can be booked. Audit so the partner can see why.
      if (step.kind === 'AUTO_PAUSE' && inv.primaryEngagementId) {
        log.warn(
          { invoiceId: inv.id, engagementId: inv.primaryEngagementId },
          'auto-pause threshold reached',
        );
        await db
          .update(engagements)
          .set({ status: 'PAUSED', updatedAt: new Date() })
          .where(eq(engagements.id, inv.primaryEngagementId));
        try {
          await db.insert(auditLog).values({
            action: 'UPDATE',
            entityType: 'engagement',
            entityId: inv.primaryEngagementId,
            actorMcpTokenId: 'dunning-sweep-worker',
            beforeJson: { status: 'ACTIVE' },
            afterJson: {
              status: 'PAUSED',
              reason: 'auto_pause_dunning',
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
            },
          });
        } catch (err) {
          log.error({ err }, 'audit emit for auto-pause failed');
        }
      }
    }
    if (due.length > 0 && inv.status === 'SENT') {
      await db.update(invoices).set({ status: 'OVERDUE' }).where(eq(invoices.id, inv.id));
    }
  }

  return { scanned: overdue.length, stepsFired, sentEmails, sentSms };
}
