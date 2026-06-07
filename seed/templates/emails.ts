import type { EmailTemplate } from './types';

/**
 * System email templates — operational transactional emails only.
 *
 * These cover the standard proposal-to-engagement lifecycle events.
 * Firms clone them on first use and customize tone, signature, and
 * branding to match their voice.
 *
 * Merge tokens follow the same mustache convention as terms templates.
 * Tokens available depend on the email kind — see comments per template.
 */
export const SYSTEM_EMAIL_TEMPLATES: EmailTemplate[] = [
  // --------------------------------------------------------------------------
  // 1. Proposal Sent — initial delivery to client
  // --------------------------------------------------------------------------
  {
    slug: 'proposal-sent-default',
    kind: 'proposal_sent',
    subject: 'Your proposal from {{ firm.display_name }} is ready',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

Your proposal is ready for review. You'll find the full scope, pricing, and engagement terms at the link below.

[Review your proposal]({{ proposal.acceptance_url }})

The proposal is valid until {{ proposal.expires_at }}. If you have any questions before you decide, reply to this email and I'll get back to you within {{ firm.standard_response_time }}.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
    plainTextBody: `Hi {{ client.primary_contact_first_name }},

Your proposal is ready for review. You'll find the full scope, pricing, and engagement terms at the link below.

Review your proposal: {{ proposal.acceptance_url }}

The proposal is valid until {{ proposal.expires_at }}. If you have any questions before you decide, reply to this email and I'll get back to you within {{ firm.standard_response_time }}.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 2. Proposal Reminder — Not Yet Viewed
  // --------------------------------------------------------------------------
  {
    slug: 'proposal-reminder-not-viewed',
    kind: 'proposal_reminder_view',
    subject: 'Quick reminder — your proposal from {{ firm.display_name }} is waiting',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

Just a quick note that the proposal I sent on {{ proposal.sent_at }} is still waiting for your review.

[Open the proposal]({{ proposal.acceptance_url }})

It expires on {{ proposal.expires_at }}. If anything has changed on your end or if you'd prefer to discuss it over a quick call, just reply and let me know.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 3. Proposal Reminder — Viewed but Not Signed
  // --------------------------------------------------------------------------
  {
    slug: 'proposal-reminder-not-signed',
    kind: 'proposal_reminder_sign',
    subject: 'Following up on your proposal',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

I noticed you had a chance to look at the proposal — thank you for that. I wanted to follow up in case you had any questions about the scope, the tiers, or anything else.

[Return to the proposal]({{ proposal.acceptance_url }})

The proposal is valid until {{ proposal.expires_at }}. Reply to this email if you'd like to talk through anything before deciding.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 4. Proposal Accepted — receipt and next steps
  // --------------------------------------------------------------------------
  {
    slug: 'proposal-accepted-default',
    kind: 'proposal_accepted',
    subject: 'Welcome — your engagement with {{ firm.display_name }} is active',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

Thank you for accepting our proposal. Your engagement is now active.

**Engagement summary**
- Tier selected: {{ engagement.tier_name }}
- Start date: {{ engagement.start_date }}
- Billing schedule: {{ engagement.billing_summary }}

A signed copy of the proposal and engagement letter is available in your portal:

[Open your portal]({{ portal.url }})

We'll be in touch with next steps shortly. If anything is urgent before then, reply to this email or call us at {{ firm.phone }}.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 5. Proposal Expired — graceful follow-up
  // --------------------------------------------------------------------------
  {
    slug: 'proposal-expired-default',
    kind: 'proposal_expired',
    subject: 'Your proposal from {{ firm.display_name }} has expired',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

The proposal I sent on {{ proposal.sent_at }} expired on {{ proposal.expires_at }}.

If you'd still like to move forward, just reply and let me know — I can refresh the proposal with current pricing and send a new link. If you've decided to go a different direction, that's understandable; I appreciate you considering us.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 6. Engagement Welcome — sent after acceptance, with onboarding next steps
  // --------------------------------------------------------------------------
  {
    slug: 'engagement-welcome-default',
    kind: 'engagement_welcome',
    subject: "Welcome to {{ firm.display_name }} — here's what happens next",
    bodyMd: `Hi {{ client.primary_contact_first_name }},

Welcome aboard. Here's what to expect over the next few days:

1. **Document requests.** We'll send a list of items we need to get started. You can upload them through your portal.
2. **Kickoff.** Once we have what we need, we'll begin work according to the schedule in your proposal.
3. **Communication.** Your main point of contact is {{ engagement.primary_contact }}. You can reach us through the portal, by email, or at {{ firm.phone }}.

[Open your portal]({{ portal.url }})

If you have any questions in the meantime, just reply to this email.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 7. Invoice Receipt — confirmation of payment
  // --------------------------------------------------------------------------
  {
    slug: 'invoice-receipt-default',
    kind: 'invoice_receipt',
    subject: 'Payment received — {{ invoice.number }}',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

We received your payment of {{ invoice.amount_formatted }} for invoice {{ invoice.number }}.

[View receipt]({{ invoice.hosted_url }})

If you have any questions about the invoice or the engagement, reply to this email.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 8. Payment Failed — operational notification
  // --------------------------------------------------------------------------
  {
    slug: 'payment-failed-default',
    kind: 'payment_failed',
    subject: 'Issue with your recent payment',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

We weren't able to process your payment of {{ invoice.amount_formatted }} for invoice {{ invoice.number }}. The processor reported: {{ invoice.failure_reason }}.

[Update your payment method]({{ portal.payment_method_url }})

We'll automatically retry on {{ invoice.next_retry_date }}. If you'd like to use a different payment method or have any questions, reply to this email or call us at {{ firm.phone }}.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 9. Mandate Invalid — bank-account authorization needs refresh
  // --------------------------------------------------------------------------
  {
    slug: 'mandate-invalid-default',
    kind: 'mandate_invalid',
    subject: 'Action needed — bank authorization needs to be refreshed',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

The bank authorization on file for your engagement is no longer valid. This sometimes happens after a bank account change, a disputed charge, or an expired authorization.

To keep your engagement running without interruption, please update your payment method:

[Update your payment method]({{ portal.payment_method_url }})

If you have any questions, reply to this email or call us at {{ firm.phone }}.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },

  // --------------------------------------------------------------------------
  // 10. Renewal Upcoming — non-aggressive, info-only renewal nudge
  // --------------------------------------------------------------------------
  {
    slug: 'renewal-upcoming-default',
    kind: 'renewal_upcoming',
    subject: 'Your engagement is coming up for renewal',
    bodyMd: `Hi {{ client.primary_contact_first_name }},

Your current engagement with us is set to end on {{ engagement.ends_on }}. We'll be sending a renewal proposal shortly so you can review next year's scope and pricing.

If anything has changed in your situation — new entities, sale of an entity, additional services you'd like to add, services you'd like to drop — let us know so we can scope the renewal accordingly.

Thanks,
{{ firm.signatory_name }}
{{ firm.display_name }}`,
  },
];
