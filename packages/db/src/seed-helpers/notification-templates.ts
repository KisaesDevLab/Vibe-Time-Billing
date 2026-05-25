// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Default notification template content (v2 Sprint A, workstream 3.4).
//
// Seeds 15 standard kinds × 2 channels (EMAIL + SMS) = 30 rows per firm
// on first init. Per Q28 (locked) these are variable-substitution
// templates — Handlebars-style {{placeholder}} markers — not HTML.
//
// Re-running is idempotent: rows are upserted (ON CONFLICT DO NOTHING
// via the unique (firm_id, kind, channel) constraint) so an admin who
// has already customized a template will not have it overwritten.

import { sql } from 'drizzle-orm';
import type { PgDatabase, QueryResultHKT } from 'drizzle-orm/pg-core';

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
type Tx = PgDatabase<QueryResultHKT, any, any>;

interface TemplateDef {
  kind: string;
  channel: 'EMAIL' | 'SMS';
  subject?: string;
  body: string;
}

// All variables follow `entity.field` style. Available variables are
// mined from the body at PUT time by the admin route (admin/routes.ts).
const DEFAULTS: ReadonlyArray<TemplateDef> = [
  // Invoice lifecycle ----------------------------------------------
  {
    kind: 'invoice_sent',
    channel: 'EMAIL',
    subject: 'Invoice {{invoice.number}} from {{firm.displayName}}',
    body:
      'Hi {{client.name}},\n\n' +
      'Your latest invoice is ready. Total: {{invoice.total}}. Due: {{invoice.due_date}}.\n\n' +
      'View and pay online: {{invoice.portal_url}}\n\n' +
      'Thanks,\n{{firm.displayName}}',
  },
  {
    kind: 'invoice_sent',
    channel: 'SMS',
    body: '{{firm.displayName}}: invoice {{invoice.number}} is ready. {{invoice.total}} due {{invoice.due_date}}. {{invoice.portal_url}}',
  },
  {
    kind: 'invoice_overdue_3',
    channel: 'EMAIL',
    subject: 'Friendly reminder: invoice {{invoice.number}} is past due',
    body: 'Hi {{client.name}},\n\nInvoice {{invoice.number}} ({{invoice.total}}) is 3 days past its {{invoice.due_date}} due date.\n\nPay now: {{invoice.portal_url}}\n\nIf payment has been sent, please disregard.\n\n{{firm.displayName}}',
  },
  {
    kind: 'invoice_overdue_3',
    channel: 'SMS',
    body: 'Reminder: {{firm.displayName}} invoice {{invoice.number}} for {{invoice.total}} is past due. Pay: {{invoice.portal_url}}',
  },
  {
    kind: 'invoice_overdue_7',
    channel: 'EMAIL',
    subject: 'Past due: invoice {{invoice.number}}',
    body: 'Hi {{client.name}},\n\nInvoice {{invoice.number}} ({{invoice.total}}) is now 7 days past due.\n\nPlease remit at your earliest convenience: {{invoice.portal_url}}\n\nQuestions? Reach us at {{firm.supportEmail}}.\n\n{{firm.displayName}}',
  },
  {
    kind: 'invoice_overdue_7',
    channel: 'SMS',
    body: '{{firm.displayName}}: invoice {{invoice.number}} ({{invoice.total}}) is 7 days past due. {{invoice.portal_url}}',
  },
  {
    kind: 'invoice_overdue_14',
    channel: 'EMAIL',
    subject: 'Action required: invoice {{invoice.number}}',
    body: 'Hi {{client.name}},\n\nInvoice {{invoice.number}} ({{invoice.total}}) is now 14 days past due.\n\nIf payment is not received within the next 7 days, this account may be referred for collection.\n\nPay online: {{invoice.portal_url}}\nReach us: {{firm.supportEmail}} · {{firm.supportPhone}}\n\n{{firm.displayName}}',
  },
  {
    kind: 'invoice_overdue_14',
    channel: 'SMS',
    body: '{{firm.displayName}}: invoice {{invoice.number}} is 14 days past due. Call {{firm.supportPhone}} or pay: {{invoice.portal_url}}',
  },

  // Payment lifecycle ----------------------------------------------
  {
    kind: 'payment_received',
    channel: 'EMAIL',
    subject: 'Payment received — thank you',
    body: 'Hi {{client.name}},\n\nWe received your payment of {{payment.amount}} toward invoice {{invoice.number}}. Receipt: {{payment.receipt_url}}\n\nThanks,\n{{firm.displayName}}',
  },
  {
    kind: 'payment_received',
    channel: 'SMS',
    body: '{{firm.displayName}}: received {{payment.amount}} for invoice {{invoice.number}}. Thanks!',
  },
  {
    kind: 'payment_failed',
    channel: 'EMAIL',
    subject: 'Payment failed for invoice {{invoice.number}}',
    body: 'Hi {{client.name}},\n\nYour payment for invoice {{invoice.number}} ({{invoice.total}}) did not go through.\n\nUpdate your payment method or retry: {{invoice.portal_url}}\n\n{{firm.displayName}}',
  },
  {
    kind: 'payment_failed',
    channel: 'SMS',
    body: '{{firm.displayName}}: payment failed for invoice {{invoice.number}}. Update: {{invoice.portal_url}}',
  },
  {
    kind: 'autopay_retry_failed',
    channel: 'EMAIL',
    subject: 'Autopay retry failed',
    body: 'Hi {{client.name}},\n\nThis is the last automatic retry for invoice {{invoice.number}} ({{invoice.total}}). Please update your payment method to avoid service interruption.\n\n{{invoice.portal_url}}\n\n{{firm.displayName}}',
  },
  {
    kind: 'autopay_retry_failed',
    channel: 'SMS',
    body: '{{firm.displayName}}: final autopay retry failed for invoice {{invoice.number}}. Update payment: {{invoice.portal_url}}',
  },

  // Recurring billing ----------------------------------------------
  {
    kind: 'recurring_renewal_upcoming',
    channel: 'EMAIL',
    subject: 'Upcoming renewal: {{recurring.plan_name}}',
    body: 'Hi {{client.name}},\n\nYour {{recurring.plan_name}} renews on {{recurring.next_period_start}} for {{recurring.amount}}.\n\nManage your subscription: {{recurring.portal_url}}\n\n{{firm.displayName}}',
  },
  {
    kind: 'recurring_renewal_upcoming',
    channel: 'SMS',
    body: '{{firm.displayName}}: {{recurring.plan_name}} renews {{recurring.next_period_start}} for {{recurring.amount}}.',
  },
  {
    kind: 'recurring_renewal_complete',
    channel: 'EMAIL',
    subject: 'Renewal complete: {{recurring.plan_name}}',
    body: 'Hi {{client.name}},\n\nYour {{recurring.plan_name}} has renewed for {{recurring.amount}}. Invoice {{invoice.number}}.\n\n{{firm.displayName}}',
  },
  {
    kind: 'recurring_renewal_complete',
    channel: 'SMS',
    body: '{{firm.displayName}}: {{recurring.plan_name}} renewed. Invoice {{invoice.number}}.',
  },

  // Engagement letters ---------------------------------------------
  {
    kind: 'engagement_letter_sent',
    channel: 'EMAIL',
    subject: 'Engagement letter from {{firm.displayName}}',
    body: 'Hi {{client.name}},\n\nPlease review and accept the engagement letter for {{engagement.name}}.\n\nReview: {{letter.portal_url}}\n\n{{firm.displayName}}',
  },
  {
    kind: 'engagement_letter_sent',
    channel: 'SMS',
    body: '{{firm.displayName}}: engagement letter for {{engagement.name}} is ready to review: {{letter.portal_url}}',
  },
  {
    kind: 'engagement_letter_accepted',
    channel: 'EMAIL',
    subject: 'Engagement letter accepted',
    body: "We've received your acceptance of the engagement letter for {{engagement.name}}. Thanks!\n\n{{firm.displayName}}",
  },
  {
    kind: 'engagement_letter_accepted',
    channel: 'SMS',
    body: '{{firm.displayName}}: engagement letter accepted for {{engagement.name}}. Thanks!',
  },
  {
    kind: 'engagement_letter_voided',
    channel: 'EMAIL',
    subject: 'Engagement letter voided',
    body: 'The engagement letter for {{engagement.name}} has been voided. If this was unexpected, please reach out to {{firm.supportEmail}}.\n\n{{firm.displayName}}',
  },
  {
    kind: 'engagement_letter_voided',
    channel: 'SMS',
    body: '{{firm.displayName}}: engagement letter for {{engagement.name}} was voided. Questions: {{firm.supportPhone}}',
  },

  // Auth & portal --------------------------------------------------
  {
    kind: 'portal_invite',
    channel: 'EMAIL',
    subject: 'Your client portal invitation',
    body: "Hi {{contact.name}},\n\nYou've been invited to access {{firm.displayName}}'s client portal. Use the link below to sign in:\n\n{{portal.invite_url}}\n\nThis link expires in 24 hours.",
  },
  {
    kind: 'portal_invite',
    channel: 'SMS',
    body: '{{firm.displayName}} portal invite: {{portal.invite_url}} (expires in 24h)',
  },
  {
    kind: 'portal_otp_login',
    channel: 'EMAIL',
    subject: 'Your sign-in code: {{otp.code}}',
    body: 'Your {{firm.displayName}} portal sign-in code is {{otp.code}}. Expires in 5 minutes.',
  },
  {
    kind: 'portal_otp_login',
    channel: 'SMS',
    body: '{{firm.displayName}}: your sign-in code is {{otp.code}}. Expires in 5 min.',
  },

  // Workflow -------------------------------------------------------
  {
    kind: 'approval_request',
    channel: 'EMAIL',
    subject: 'Approval requested: {{approval.entity_type}}',
    body: 'Hi {{approver.name}},\n\nA {{approval.entity_type}} requires your approval ({{approval.amount}}).\n\nReview: {{approval.portal_url}}\n\n{{firm.displayName}}',
  },
  {
    kind: 'approval_request',
    channel: 'SMS',
    body: '{{firm.displayName}}: {{approval.entity_type}} approval requested. {{approval.portal_url}}',
  },
  {
    kind: 'approval_decision',
    channel: 'EMAIL',
    subject: 'Approval decision: {{approval.decision}}',
    body: 'Your {{approval.entity_type}} approval request was {{approval.decision}} by {{approver.name}}.\n\n{{firm.displayName}}',
  },
  {
    kind: 'approval_decision',
    channel: 'SMS',
    body: '{{firm.displayName}}: approval {{approval.decision}} by {{approver.name}}.',
  },

  // P4.1 — Connect-addendum H.2 ---------------------------------------
  {
    kind: 'deliverable_unlocked',
    channel: 'EMAIL',
    subject: 'New files available from {{firm.displayName}}',
    body:
      'Hi {{client.name}},\n\n' +
      '{{firm.displayName}} has released {{deliverable.file_count}} file{{deliverable.file_count_plural}} ' +
      'tied to invoice {{invoice.number}}. Sign in to view {{deliverable.file_count_them}}:\n\n' +
      '{{portal.files_url}}\n\n' +
      'Thanks,\n{{firm.displayName}}',
  },
  {
    kind: 'deliverable_unlocked',
    channel: 'SMS',
    body: '{{firm.displayName}}: {{deliverable.file_count}} file{{deliverable.file_count_plural}} ready for invoice {{invoice.number}}. {{portal.files_url}}',
  },
  {
    kind: 'wip_threshold_exceeded',
    channel: 'EMAIL',
    subject: 'WIP threshold exceeded on {{engagement.name}}',
    body:
      'Hi {{staff.name}},\n\n' +
      'Engagement {{engagement.name}} for {{client.name}} has crossed its WIP threshold ' +
      '({{wip.current}} vs. {{wip.threshold}}).\n\n' +
      'Review: {{engagement.portal_url}}\n\n' +
      '{{firm.displayName}}',
  },
  {
    kind: 'wip_threshold_exceeded',
    channel: 'SMS',
    body: '{{firm.displayName}}: {{engagement.name}} WIP {{wip.current}} > {{wip.threshold}}. Review: {{engagement.portal_url}}',
  },
  {
    kind: 'step_up_lockout',
    channel: 'EMAIL',
    subject: 'Step-up lockout triggered for {{actor.label}}',
    body:
      'Hi {{admin.name}},\n\n' +
      '{{actor.label}} has been locked out of step-up verification after {{lockout.failed_attempts}} ' +
      'failed attempts.\n\n' +
      'Lockout expires in {{lockout.retry_after_minutes}} minutes ({{lockout.expires_at}}).\n\n' +
      'Review the audit log: {{audit.portal_url}}\n\n' +
      '{{firm.displayName}}',
  },
  {
    kind: 'step_up_lockout',
    channel: 'SMS',
    body: '{{firm.displayName}}: step-up lockout for {{actor.label}}. Expires {{lockout.expires_at}}.',
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
