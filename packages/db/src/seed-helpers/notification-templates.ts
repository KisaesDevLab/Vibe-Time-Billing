// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Default notification template content.
//
// The kinds and channels here are kept in lock-step with the admin
// editor's KINDS registry (apps/web/src/pages/admin/NotificationTemplates.tsx)
// so every row the grid exposes is seeded with professional, ready-to-send
// copy — no blank templates. Variable-substitution markers use the
// `{{ entity.field }}` convention the dispatcher resolves at send time.
//
// Re-running is idempotent: rows are upserted (ON CONFLICT DO NOTHING
// via the unique (firm_id, kind, channel) constraint) so an admin who
// has already customized a template will not have it overwritten. The
// appointment_* bodies deliberately mirror the baked-in defaults in
// apps/api/src/appointments/email-jobs.ts so seeding them changes nothing
// about what clients receive until an admin edits them.

import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { notificationTemplates } from '../schema/core';

// The seed-helper accepts any PgDatabase or transaction handle — the
// seed script uses an untyped drizzle, the API uses one parameterised
// over the schema generic. Both share the PgDatabase base interface
// so we drop schema-specific generics here and let the call site type-
// check against the table reference itself.
// reason: drizzle-orm's per-schema Tx types are not assignment-compatible
// across call sites; widening to the base PgDatabase keeps the helper
// usable from both.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgDatabase<PgQueryResultHKT, any, any>;

interface TemplateDef {
  kind: string;
  channel: 'EMAIL' | 'SMS' | 'CALL';
  subject?: string;
  body: string;
}

// All variables follow `entity.field` style. Available variables are
// mined from the body at PUT time by the admin route (admin/routes.ts).
const DEFAULTS: ReadonlyArray<TemplateDef> = [
  // Invoice delivery -----------------------------------------------
  {
    kind: 'invoice_sent',
    channel: 'EMAIL',
    subject: 'Invoice {{ invoice.number }} from {{ firm.displayName }}',
    body:
      'Dear {{ client.name }},\n\n' +
      'Thank you for the opportunity to work with you. Your invoice is now ready.\n\n' +
      'Invoice: {{ invoice.number }}\n' +
      'Amount due: {{ invoice.total }}\n' +
      'Due date: {{ invoice.due_date }}\n\n' +
      'You can review the details and pay securely online at any time:\n' +
      '{{ invoice.portal_url }}\n\n' +
      'If you have any questions about this invoice, simply reply to this email or contact us at {{ firm.supportEmail }}.\n\n' +
      'With appreciation,\n{{ firm.displayName }}',
  },

  // Overdue / collections ------------------------------------------
  {
    kind: 'invoice_overdue',
    channel: 'EMAIL',
    subject: 'Past due: invoice {{ invoice.number }} from {{ firm.displayName }}',
    body:
      'Dear {{ client.name }},\n\n' +
      'Our records show that invoice {{ invoice.number }} for {{ invoice.total }}, due on {{ invoice.due_date }}, remains unpaid. The current outstanding balance is {{ invoice.balance }}.\n\n' +
      'Pay securely online — no account or sign-in required:\n' +
      '{{ invoice.pay_url }}\n\n' +
      'Or view the invoice in your portal: {{ invoice.portal_url }}\n\n' +
      'If you have already sent payment, please accept our thanks and disregard this notice. If you have any questions or would like to discuss payment arrangements, contact us at {{ firm.supportEmail }} or {{ firm.supportPhone }}.\n\n' +
      'Sincerely,\n{{ firm.displayName }}',
  },
  {
    kind: 'invoice_overdue',
    channel: 'SMS',
    body: '{{ firm.displayName }}: invoice {{ invoice.number }} (balance {{ invoice.balance }}) is past due. Pay securely (no login): {{ invoice.pay_url }}',
  },

  // 0181 — no-login pay-by-link payment request ("Send payment request").
  // {{ invoice.pay_url }} opens a secure page that needs no portal sign-in.
  {
    kind: 'invoice_payment_request',
    channel: 'EMAIL',
    subject: 'Payment request: invoice {{ invoice.number }} from {{ firm.displayName }}',
    body:
      'Dear {{ client.name }},\n\n' +
      'A payment of {{ invoice.balance }} is requested for invoice {{ invoice.number }}.\n\n' +
      'You can pay securely online — no account or sign-in required:\n' +
      '{{ invoice.pay_url }}\n\n' +
      'If you have any questions, simply reply to this email or contact us at {{ firm.supportEmail }}.\n\n' +
      'With appreciation,\n{{ firm.displayName }}',
  },
  {
    kind: 'invoice_payment_request',
    channel: 'SMS',
    body: '{{ firm.displayName }}: invoice {{ invoice.number }}, balance {{ invoice.balance }}. Pay securely (no login): {{ invoice.pay_url }}',
  },
  {
    kind: 'dunning_first',
    channel: 'EMAIL',
    subject: 'A friendly reminder about invoice {{ invoice.number }}',
    body:
      'Dear {{ client.name }},\n\n' +
      'This is a friendly reminder that invoice {{ invoice.number }} for {{ invoice.total }} is now past its due date of {{ invoice.due_date }}. The outstanding balance is {{ invoice.balance }}.\n\n' +
      'We know these things can slip through the cracks — you can settle the balance in just a few clicks:\n' +
      '{{ invoice.portal_url }}\n\n' +
      'If your payment is already on its way, thank you, and please disregard this note.\n\n' +
      'Warm regards,\n{{ firm.displayName }}',
  },
  {
    kind: 'dunning_first',
    channel: 'SMS',
    body: '{{ firm.displayName }}: a friendly reminder that invoice {{ invoice.number }} (balance {{ invoice.balance }}) is past due. Pay here: {{ invoice.portal_url }}',
  },
  {
    kind: 'dunning_second',
    channel: 'EMAIL',
    subject: 'Second notice: invoice {{ invoice.number }} needs your attention',
    body:
      'Dear {{ client.name }},\n\n' +
      'Despite our earlier reminder, invoice {{ invoice.number }} for {{ invoice.total }} (balance {{ invoice.balance }}), originally due on {{ invoice.due_date }}, remains unpaid.\n\n' +
      'To keep your account in good standing, please remit payment as soon as possible:\n' +
      '{{ invoice.portal_url }}\n\n' +
      'If there is a problem with this invoice, or you would like to arrange a payment plan, please reach us right away at {{ firm.supportEmail }} or {{ firm.supportPhone }} so we can help.\n\n' +
      'Thank you for your prompt attention,\n{{ firm.displayName }}',
  },
  {
    kind: 'dunning_second',
    channel: 'SMS',
    body: '{{ firm.displayName }}: second notice — invoice {{ invoice.number }} (balance {{ invoice.balance }}) is overdue. Please pay or call {{ firm.supportPhone }}. {{ invoice.portal_url }}',
  },

  // Payment --------------------------------------------------------
  {
    kind: 'payment_received',
    channel: 'EMAIL',
    subject: 'Payment received — thank you',
    body:
      'Dear {{ client.name }},\n\n' +
      'Thank you! We have received your payment toward invoice {{ invoice.number }}.\n\n' +
      'Remaining balance: {{ invoice.balance }}\n\n' +
      'You can view your invoices and full payment history any time in your portal:\n' +
      '{{ invoice.portal_url }}\n\n' +
      'We truly appreciate your business.\n\n' +
      'Sincerely,\n{{ firm.displayName }}',
  },

  // Authentication -------------------------------------------------
  {
    kind: 'magic_link',
    channel: 'EMAIL',
    subject: 'Your secure sign-in link for {{ firm.displayName }}',
    body:
      'Hello,\n\n' +
      'Use the secure link below to sign in to your {{ firm.displayName }} account:\n\n' +
      '{{ auth.magic_url }}\n\n' +
      'For your security, this link works only once and expires shortly. If you did not request it, you can safely ignore this email — no action is needed.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'password_reset',
    channel: 'EMAIL',
    subject: 'Reset your {{ firm.displayName }} password',
    body:
      'Hello,\n\n' +
      'We received a request to reset the password for your {{ firm.displayName }} account. Use the link below to choose a new password:\n\n' +
      '{{ auth.reset_url }}\n\n' +
      'This link works only once and expires shortly. If you did not request a reset, you can safely ignore this email — your password has not changed.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'sms_otp',
    channel: 'SMS',
    body: '{{ firm.displayName }}: your verification code is {{ auth.code }}. It expires in 10 minutes. For your security, do not share this code with anyone.',
  },

  // Appointments (mirror apps/api/src/appointments/email-jobs.ts) --
  {
    kind: 'appointment_confirmation',
    channel: 'EMAIL',
    subject: 'Confirmed: {{ appointment.subject }} on {{ appointment.date }}',
    body:
      'Hi {{ client.name }},\n\n' +
      'Your appointment is confirmed:\n\n' +
      '{{ appointment.subject }}\n' +
      '{{ appointment.date }} at {{ appointment.time }} ({{ appointment.duration }} min)\n' +
      'With: {{ staff.names }}\n' +
      '{{ appointment.location_type_label }}: {{ appointment.location_detail }}\n\n' +
      'Need to cancel? {{ appointment.cancel_url }}\n' +
      'Need a different time? {{ appointment.reschedule_request_url }}\n\n' +
      '— {{ firm.name }}',
  },
  {
    kind: 'appointment_reschedule_confirmation',
    channel: 'EMAIL',
    subject: 'Updated time: {{ appointment.subject }} on {{ appointment.date }}',
    body:
      'Hi {{ client.name }},\n\n' +
      'Your appointment has been rescheduled to:\n\n' +
      '{{ appointment.date }} at {{ appointment.time }} ({{ appointment.duration }} min)\n' +
      'With: {{ staff.names }}\n' +
      '{{ appointment.location_type_label }}: {{ appointment.location_detail }}\n\n' +
      'Need to cancel? {{ appointment.cancel_url }}\n\n' +
      '— {{ firm.name }}',
  },
  {
    kind: 'appointment_cancellation',
    channel: 'EMAIL',
    subject: 'Cancelled: {{ appointment.subject }} on {{ appointment.date }}',
    body:
      'Hi {{ client.name }},\n\n' +
      'Your appointment on {{ appointment.date }} at {{ appointment.time }} with {{ staff.names }} has been cancelled by {{ appointment.cancelled_by }}.\n\n' +
      'Please contact us to find another time.\n\n' +
      '— {{ firm.name }}',
  },
  {
    kind: 'appointment_reminder',
    channel: 'EMAIL',
    subject: 'Reminder: {{ appointment.subject }} on {{ appointment.date }}',
    body:
      'Hi {{ client.name }},\n\n' +
      'A reminder of your upcoming appointment:\n\n' +
      '{{ appointment.subject }}\n' +
      '{{ appointment.date }} at {{ appointment.time }} ({{ appointment.duration }} min)\n' +
      'With: {{ staff.names }}\n' +
      '{{ appointment.location_type_label }}: {{ appointment.location_detail }}\n\n' +
      'Need to cancel? {{ appointment.cancel_url }}\n' +
      'Need a different time? {{ appointment.reschedule_request_url }}\n\n' +
      '— {{ firm.name }}',
  },
  {
    kind: 'appointment_reminder',
    channel: 'SMS',
    body: 'Reminder: {{ appointment.subject }} on {{ appointment.date }} at {{ appointment.time }} with {{ staff.names }}. Reply YES to confirm.',
  },
  {
    kind: 'appointment_reminder',
    channel: 'CALL',
    body: 'Hello {{ client.name }}. This is a reminder from {{ firm.name }} about your appointment, {{ appointment.subject }}, on {{ appointment.date }} at {{ appointment.time }}.',
  },
  {
    kind: 'appointment_reschedule_request_declined',
    channel: 'EMAIL',
    subject: 'About your reschedule request — {{ appointment.subject }}',
    body:
      'Hi {{ client.name }},\n\n' +
      "We weren't able to move your appointment on {{ appointment.date }}. The original time still stands. If it no longer works, you can cancel here:\n" +
      '{{ appointment.cancel_url }}\n\n' +
      '— {{ firm.name }}',
  },
  {
    kind: 'appointment_reschedule_requested_staff',
    channel: 'EMAIL',
    subject: 'Reschedule requested: {{ appointment.subject }} ({{ appointment.date }})',
    body:
      '{{ client.name }} asked to reschedule:\n\n' +
      '{{ appointment.subject }}\n' +
      'Currently {{ appointment.date }} at {{ appointment.time }}\n' +
      'With: {{ staff.names }}\n\n' +
      'Their note: {{ request.message }}\n\n' +
      'Review and propose a new time in the reschedule inbox.\n\n' +
      '— {{ firm.name }}',
  },

  // Intake — secure document-upload link ---------------------------
  {
    kind: 'intake_link',
    channel: 'EMAIL',
    subject: 'Securely send your documents to {{ firm.displayName }}',
    body:
      '{{ staff.name }} at {{ firm.displayName }} has invited you to securely upload your documents. ' +
      'Use the private link below — no account or password needed:\n\n' +
      '{{ link.url }}\n\n' +
      'For your security, this link expires in {{ link.expires_days }} days.\n\n' +
      'If you have any questions, simply reply to this email or contact us at {{ firm.support_email }}.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'intake_link',
    channel: 'SMS',
    body: '{{ staff.name }} at {{ firm.displayName }}: securely upload your documents here (link expires in {{ link.expires_days }} days): {{ link.url }}',
  },

  // Portal access — invite / approval ------------------------------
  {
    kind: 'portal_invite',
    channel: 'EMAIL',
    subject: 'Your secure client portal with {{ firm.displayName }}',
    body:
      'Hello,\n\n' +
      '{{ firm.displayName }} has invited you to a secure online portal where you can view invoices, ' +
      'make payments, and exchange documents. Get started here:\n\n' +
      '{{ link.url }}\n\n' +
      "You'll confirm your identity with a one-time code — there's no password to remember.\n\n" +
      'If you have any questions, contact us at {{ firm.support_email }}.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'portal_invite',
    channel: 'SMS',
    body: '{{ firm.displayName }} invited you to your secure client portal: {{ link.url }}',
  },

  // Statement of account -------------------------------------------
  {
    kind: 'statement_sent',
    channel: 'EMAIL',
    subject: 'Your account statement from {{ firm.displayName }}',
    body:
      'Dear {{ client.name }},\n\n' +
      'Your account statement is attached. The current balance is {{ statement.balance }}.\n\n' +
      'If you have any questions about your account, contact us at {{ firm.support_email }} or {{ firm.support_phone }}.\n\n' +
      'Sincerely,\n{{ firm.displayName }}',
  },

  // Engagement letter ----------------------------------------------
  {
    kind: 'engagement_letter_sent',
    channel: 'EMAIL',
    subject: 'Please review and sign your engagement letter',
    body:
      'Hello,\n\n' +
      'Your engagement letter from {{ firm.displayName }} is ready for your review and signature:\n\n' +
      '{{ link.url }}\n\n' +
      'Please review it carefully and sign at your earliest convenience so we can begin work. ' +
      'If you have any questions, reply to this email or contact us at {{ firm.support_email }}.\n\n' +
      'Thank you,\n{{ firm.displayName }}',
  },

  // E-signature ----------------------------------------------------
  {
    kind: 'signature_request',
    channel: 'EMAIL',
    subject: 'Your signature is requested: {{ document.name }}',
    body:
      'Dear {{ client.name }},\n\n' +
      '{{ firm.displayName }} has sent you a document that needs your signature:\n\n' +
      '{{ document.name }}\n\n' +
      'Review and sign securely here:\n{{ link.url }}\n\n' +
      'If you have any questions, contact us at {{ firm.support_email }}.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'signature_request',
    channel: 'SMS',
    body: '{{ firm.displayName }}: {{ client.name }}, please sign {{ document.name }}: {{ link.url }}',
  },
  {
    kind: 'signature_complete',
    channel: 'EMAIL',
    subject: 'Your document has been fully signed',
    body:
      'Hello,\n\n' +
      'Thank you — {{ document.name }} has been fully signed and is complete.\n\n' +
      // Resolves to "Your signed copy is attached to this email." when the
      // PDF could be enclosed, otherwise to who to contact for one. The old
      // copy promised a copy without saying how to get it.
      '{{ document.copy_note }}\n\n' +
      'We appreciate your business.\n\n' +
      '{{ firm.displayName }}',
  },

  // Retainers ------------------------------------------------------
  {
    kind: 'retainer_activated',
    channel: 'EMAIL',
    subject: 'Your retainer with {{ firm.displayName }} is active',
    body:
      'Dear {{ client.name }},\n\n' +
      'Your retainer {{ retainer.name }} is now active with a balance of {{ retainer.balance }}.\n\n' +
      'Thank you for your business.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'retainer_exhausted',
    channel: 'EMAIL',
    subject: 'Your retainer balance needs attention',
    body:
      'Dear {{ client.name }},\n\n' +
      'Your retainer {{ retainer.name }} has been fully applied (remaining balance {{ retainer.balance }}). ' +
      'To avoid any interruption in service, please contact us to replenish it:\n\n' +
      '{{ firm.support_email }} or {{ firm.support_phone }}\n\n' +
      'Thank you,\n{{ firm.displayName }}',
  },
  {
    kind: 'retainer_expiring',
    channel: 'EMAIL',
    subject: 'Your retainer expires {{ retainer.expires_date }}',
    body:
      'Dear {{ client.name }},\n\n' +
      'A reminder that your retainer {{ retainer.name }} expires on {{ retainer.expires_date }} ' +
      '(remaining balance {{ retainer.balance }}).\n\n' +
      'If you would like to renew or have any questions, contact us at {{ firm.support_email }}.\n\n' +
      'Thank you,\n{{ firm.displayName }}',
  },

  // Requests — drop-off & document requests ------------------------
  {
    kind: 'dropoff_reminder',
    channel: 'EMAIL',
    subject: 'Reminder: documents for {{ engagement.name }}',
    body:
      'Dear {{ client.name }},\n\n' +
      "This is a friendly reminder that we're still waiting on documents for {{ engagement.name }}. " +
      'You can drop them off securely here:\n\n' +
      '{{ link.url }}\n\n' +
      'If you have already sent them, thank you and please disregard this note.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'dropoff_reminder',
    channel: 'SMS',
    body: '{{ firm.displayName }}: a reminder to drop off your documents for {{ engagement.name }}: {{ link.url }}',
  },
  {
    kind: 'document_request',
    channel: 'EMAIL',
    subject: 'Action needed: {{ request.title }}',
    body:
      'Dear {{ client.name }},\n\n' +
      'To keep your work moving, we need the following from you:\n\n' +
      '{{ request.title }}\n\n' +
      'Please respond securely here:\n{{ link.url }}\n\n' +
      'Questions? Contact us at {{ firm.support_email }}.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'document_request',
    channel: 'SMS',
    body: '{{ firm.displayName }}: we need a few items from you — {{ request.title }}. Respond here: {{ link.url }}',
  },

  // Tax payment reminder -------------------------------------------
  {
    kind: 'tax_payment_reminder',
    channel: 'EMAIL',
    subject: 'Upcoming tax payment due {{ payment.due_date }}',
    body:
      'Dear {{ client.name }},\n\n' +
      'This is a reminder of an upcoming tax payment:\n\n' +
      'Authority: {{ payment.authority }}\n' +
      'Amount: {{ payment.amount }}\n' +
      'Due: {{ payment.due_date }}\n\n' +
      'If you have any questions, contact us at {{ firm.support_email }} or {{ firm.support_phone }}.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'tax_payment_reminder',
    channel: 'SMS',
    body: '{{ firm.displayName }}: reminder — {{ payment.authority }} payment of {{ payment.amount }} is due {{ payment.due_date }}.',
  },

  // Deliverable unlocked (paid → files available) ------------------
  {
    kind: 'deliverable_unlocked',
    channel: 'EMAIL',
    subject: 'Your documents are ready to download',
    body:
      'Hello,\n\n' +
      'Thank you for your payment. Your completed documents from {{ firm.displayName }} are now available to download in your portal:\n\n' +
      '{{ link.url }}\n\n' +
      'We appreciate your business.\n\n' +
      '{{ firm.displayName }}',
  },

  // Secure file share ----------------------------------------------
  {
    kind: 'share_link',
    channel: 'EMAIL',
    subject: '{{ firm.displayName }} shared a document with you',
    body:
      'Hello,\n\n' +
      '{{ firm.displayName }} has securely shared a document with you.\n\n' +
      '{{ share.description }}\n\n' +
      'View it here:\n{{ link.url }}\n\n' +
      "When you open the page, you'll receive a one-time access code to unlock it.\n\n" +
      'If you have any questions, contact us at {{ firm.support_email }}.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'share_link',
    channel: 'SMS',
    body: '{{ firm.displayName }} shared a file with you: {{ link.url }}',
  },

  // Calendar reminder (non-appointment events) ---------------------
  {
    kind: 'calendar_reminder',
    channel: 'EMAIL',
    subject: 'Reminder: {{ event.subject }} on {{ event.date }}',
    body:
      'Hi {{ client.name }},\n\n' +
      'A reminder of your upcoming event with {{ firm.displayName }}:\n\n' +
      '{{ event.subject }}\n' +
      '{{ event.date }} at {{ event.time }}\n\n' +
      '— {{ firm.displayName }}',
  },

  // Authentication — email OTP -------------------------------------
  {
    kind: 'email_otp',
    channel: 'EMAIL',
    subject: 'Your verification code for {{ firm.displayName }}',
    body:
      'Hello,\n\n' +
      'Your {{ firm.displayName }} verification code is:\n\n' +
      '{{ auth.code }}\n\n' +
      'It expires in 10 minutes. For your security, do not share this code with anyone. ' +
      'If you did not request it, you can safely ignore this email.\n\n' +
      '{{ firm.displayName }}',
  },

  // Public booking — request received / declined -------------------
  {
    kind: 'booking_request_submitted',
    channel: 'EMAIL',
    subject: 'We received your booking request — {{ firm.displayName }}',
    body:
      'Hi {{ client.name }},\n\n' +
      'Thanks for requesting an appointment with {{ staff.names }} at {{ firm.displayName }}:\n\n' +
      '{{ appointment.date }} at {{ appointment.time }}\n\n' +
      "Your request is pending confirmation — we'll email you as soon as it's approved. " +
      'If the time no longer works, just reply to this email.\n\n' +
      '{{ firm.displayName }}',
  },
  {
    kind: 'booking_request_submitted',
    channel: 'SMS',
    body: '{{ firm.displayName }}: we received your booking request for {{ appointment.date }} at {{ appointment.time }}. It is pending confirmation — we will text you once it is approved.',
  },
  {
    kind: 'booking_request_declined',
    channel: 'EMAIL',
    subject: 'Update on your booking request — {{ firm.displayName }}',
    body:
      'Hi {{ client.name }},\n\n' +
      "Thank you for your interest in booking with {{ firm.displayName }}. Unfortunately we weren't able to " +
      'confirm your requested time of {{ appointment.date }} at {{ appointment.time }}.\n\n' +
      'Please feel free to request another time, or contact us at {{ firm.support_email }}.\n\n' +
      '{{ firm.displayName }}',
  },
];

/**
 * Mine {{placeholder}} markers from a template body+subject for the
 * variable picker. Same regex the PUT endpoint uses (admin/routes.ts:1012).
 */
function extractVariables(def: TemplateDef): string[] {
  const re = /{{\s*([a-zA-Z0-9_.]+)\s*}}/g;
  const seen = new Set<string>();
  const sources = [def.body, def.subject ?? ''].join('\n');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sources))) seen.add(m[1]!);
  return Array.from(seen).sort();
}

/**
 * Seed default notification templates for a firm. Idempotent: existing
 * rows are left untouched (admin overrides preserved).
 */
export async function seedNotificationTemplates(tx: Tx, firmId: string): Promise<number> {
  let inserted = 0;
  for (const def of DEFAULTS) {
    const result = await tx
      .insert(notificationTemplates)
      .values({
        firmId,
        kind: def.kind,
        channel: def.channel,
        subject: def.subject ?? null,
        body: def.body,
        variablesJson: extractVariables(def),
        enabled: true,
      })
      // Unique constraint is (firm_id, kind, channel). DO NOTHING means
      // pre-existing overrides survive re-seed runs.
      .onConflictDoNothing({
        target: [
          notificationTemplates.firmId,
          notificationTemplates.kind,
          notificationTemplates.channel,
        ],
      })
      .returning({ id: notificationTemplates.id });
    if (result.length > 0) inserted++;
  }
  // Reference sql to keep the unused import lint happy when the body
  // doesn't otherwise need it.
  void sql;
  return inserted;
}

export const NOTIFICATION_TEMPLATE_DEFAULTS = DEFAULTS;
