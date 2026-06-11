// SPDX-License-Identifier: Elastic-2.0
//
// P26 + P27 — Proposal-lifecycle notification templates.
//
// Email templates (P26) and SMS templates (P27) for the events the
// addendum's §P26/§P27 checklists name:
//   email:  proposal_sent, proposal_viewed_reminder,
//           proposal_expiring, proposal_accepted (firm + client),
//           proposal_declined, payment_received, payment_failed,
//           mandate_invalid, renewal_upcoming
//   sms:    proposal_reminder, payment_failed, mandate_invalid,
//           signed_receipt
//
// Each template is markdown + merge tokens (resolved via
// resolveMergeTokens from @vibe/core/proposals). Subject lines for
// email also pass through the same resolver so "{{ client.name }}"
// works in subject lines too.
//
// Per-firm overrides land later — when the firm-settings UI ships an
// "edit templates" surface, those overrides shadow the defaults
// below. The default catalog stays as a fallback so the system
// always has something to send.

import { resolveMergeTokens, type MergeContext } from '@vibe/core/proposals';

export type EmailEvent =
  | 'proposal_sent'
  | 'proposal_viewed_reminder'
  | 'proposal_expiring'
  | 'proposal_accepted_firm'
  | 'proposal_accepted_client'
  | 'proposal_declined'
  | 'payment_received'
  | 'payment_failed'
  | 'mandate_invalid'
  | 'renewal_upcoming';

export type SmsEvent =
  | 'proposal_reminder'
  | 'payment_failed'
  | 'mandate_invalid'
  | 'signed_receipt';

export interface EmailTemplate {
  subject: string;
  body: string; // plain-text fallback
  html?: string;
}

export interface SmsTemplate {
  body: string; // ≤160 chars to fit a single segment
}

// =====================================================================
// Email defaults
// =====================================================================

export const EMAIL_TEMPLATES: Record<EmailEvent, EmailTemplate> = {
  proposal_sent: {
    subject: 'Your engagement proposal from {{ firm.name }}',
    body: `Hi {{ client.name }},

We've prepared a proposal for {{ engagement.name }}. Review and
accept it here: {{ proposal.url }}

This link is good through {{ proposal.expires_at }}.

— {{ firm.name }}`,
  },
  proposal_viewed_reminder: {
    subject: 'Still reviewing? — {{ engagement.name }}',
    body: `Hi {{ client.name }},

A quick note — we noticed you started reviewing the {{ engagement.name }}
proposal. Let us know if you have questions, and you can return to
finish at {{ proposal.url }}.

— {{ firm.name }}`,
  },
  proposal_expiring: {
    subject: 'Your proposal expires {{ proposal.expires_at }}',
    body: `Hi {{ client.name }},

Your proposal for {{ engagement.name }} expires on {{ proposal.expires_at }}.
If you'd like to proceed, you can review and accept here:
{{ proposal.url }}.

— {{ firm.name }}`,
  },
  proposal_accepted_firm: {
    subject: 'Accepted — {{ client.name }} / {{ engagement.name }}',
    body: `{{ client.name }} accepted the {{ engagement.name }} proposal
on {{ today }}. Engagement is now live in {{ firm.name }}.`,
  },
  proposal_accepted_client: {
    subject: 'Welcome aboard — {{ engagement.name }} confirmed',
    body: `Hi {{ client.name }},

Thanks for accepting the {{ engagement.name }} engagement. Your
receipt + signed engagement letter are saved to your portal. We
look forward to working together.

— {{ firm.name }}`,
  },
  proposal_declined: {
    subject: 'Proposal declined — {{ engagement.name }}',
    body: `Hi {{ client.name }},

Thanks for letting us know the {{ engagement.name }} proposal isn't
the right fit. We're here if your needs change.

— {{ firm.name }}`,
  },
  payment_received: {
    subject: 'Payment received — {{ engagement.name }}',
    body: `Hi {{ client.name }},

We've received your payment for {{ engagement.name }}. Receipt
saved to your portal.

— {{ firm.name }}`,
  },
  payment_failed: {
    subject: 'We had trouble processing your payment',
    body: `Hi {{ client.name }},

A payment for {{ engagement.name }} didn't go through. Please review
your payment method at {{ portal.payment_methods_url }} and we'll
retry automatically.

— {{ firm.name }}`,
  },
  mandate_invalid: {
    subject: 'Action required — bank authorization needs refresh',
    body: `Hi {{ client.name }},

Your bank's ACH authorization for {{ engagement.name }} is no longer
valid (often a closed account or expired authorization). Please
re-authorize at {{ portal.payment_methods_url }}.

— {{ firm.name }}`,
  },
  renewal_upcoming: {
    subject: 'Renewing — {{ engagement.name }}',
    body: `Hi {{ client.name }},

Your {{ engagement.name }} engagement renews on
{{ engagement.end_date }}. We'll send a renewal proposal in the
next few days; reply if you'd like to discuss the upcoming term
first.

— {{ firm.name }}`,
  },
};

// =====================================================================
// SMS defaults (each body ≤160 chars to fit a single segment)
// =====================================================================

export const SMS_TEMPLATES: Record<SmsEvent, SmsTemplate> = {
  proposal_reminder: {
    body: '{{ firm.name }}: Your engagement proposal is waiting at {{ proposal.short_url }}. Expires {{ proposal.expires_at }}.',
  },
  payment_failed: {
    body: '{{ firm.name }}: We couldn’t process your payment for {{ engagement.name }}. Update card at {{ portal.short_url }}.',
  },
  mandate_invalid: {
    body: '{{ firm.name }}: ACH authorization for {{ engagement.name }} needs re-confirmation. Tap {{ portal.short_url }}.',
  },
  signed_receipt: {
    body: '{{ firm.name }}: Engagement {{ engagement.name }} is confirmed. Receipt + letter saved to your portal.',
  },
};

// =====================================================================
// Render helpers — apply merge tokens to subject + body
// =====================================================================

export function renderEmail(event: EmailEvent, ctx: MergeContext): EmailTemplate {
  const tpl = EMAIL_TEMPLATES[event];
  if (!tpl) throw new Error(`unknown_email_event:${String(event)}`);
  const subject = resolveMergeTokens(tpl.subject, ctx).output;
  const body = resolveMergeTokens(tpl.body, ctx).output;
  const html = tpl.html ? resolveMergeTokens(tpl.html, ctx).output : undefined;
  return { subject, body, html };
}

export function renderSms(event: SmsEvent, ctx: MergeContext): SmsTemplate {
  const tpl = SMS_TEMPLATES[event];
  if (!tpl) throw new Error(`unknown_sms_event:${String(event)}`);
  return { body: resolveMergeTokens(tpl.body, ctx).output };
}
