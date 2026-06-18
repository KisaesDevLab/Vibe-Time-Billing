// SPDX-License-Identifier: Elastic-2.0
//
// 0146 — engagement-status notification templates.
//
// When an engagement enters a status whose config has
// triggers_client_comm set, the pipeline renders one message per
// configured channel. A firm can customize copy per status × channel
// via notification_template rows keyed `engagement_status:<state>`;
// when no enabled row exists the channel falls back to the generic
// defaults below. Rendering reuses the proposal merge-token resolver
// (variable insertion only, per Q28 — no conditionals or loops).

import { resolveMergeTokens, type MergeContext, type TokenEntry } from '../proposals/merge-tokens';

export type StatusNotificationChannel = 'EMAIL' | 'SMS' | 'PORTAL';

export const STATUS_NOTIFICATION_CHANNELS: StatusNotificationChannel[] = ['EMAIL', 'SMS', 'PORTAL'];

/** notification_template.kind for a given workflow state. */
export function statusTemplateKind(workflowState: string): string {
  return `engagement_status:${workflowState}`;
}

export interface StatusTemplate {
  // EMAIL uses subject+body; SMS uses body; PORTAL uses subject as the
  // notification title and body as its text.
  subject?: string;
  body: string;
}

// Generic fallbacks. {{status.client_label}} resolves to the
// client-facing label when the firm set one, else the staff label —
// the pipeline builds the context that way; templates don't branch.
export const DEFAULT_STATUS_TEMPLATES: Record<StatusNotificationChannel, StatusTemplate> = {
  EMAIL: {
    subject: 'Update on {{engagement.name}}',
    body:
      'Hi {{recipient.name}},\n\n' +
      'An update from {{firm.name}} on {{engagement.name}} for {{client.name}}: ' +
      'the engagement is now "{{status.client_label}}".\n\n' +
      '{{status.client_description}}\n\n' +
      'If you have any questions, just reply to this email.\n\n' +
      '{{firm.name}}',
  },
  SMS: {
    body: '{{firm.name}}: {{engagement.name}} for {{client.name}} is now "{{status.client_label}}".',
  },
  PORTAL: {
    subject: '{{engagement.name}} is now {{status.client_label}}',
    body: '{{status.client_description}}',
  },
};

export interface StatusNotificationContext extends MergeContext {
  client: { name: string };
  firm: { name: string };
  engagement: { name: string };
  status: {
    label: string;
    client_label: string;
    client_description: string;
  };
  recipient?: { name: string };
}

export interface RenderedStatusNotification {
  subject: string | null;
  body: string;
}

/**
 * Render one channel's message. `template` is the firm's
 * notification_template row content (or null to use the default).
 * Unknown tokens render as empty string (resolver behavior); we also
 * collapse the 3+ blank lines an empty {{status.client_description}}
 * leaves behind.
 */
export function renderStatusNotification(args: {
  channel: StatusNotificationChannel;
  template: StatusTemplate | null;
  context: StatusNotificationContext;
}): RenderedStatusNotification {
  const tpl = args.template ?? DEFAULT_STATUS_TEMPLATES[args.channel];
  const subject =
    tpl.subject != null ? tidy(resolveMergeTokens(tpl.subject, args.context).output) : null;
  const body = tidy(resolveMergeTokens(tpl.body, args.context).output);
  return { subject, body };
}

function tidy(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// Token catalog for the admin variable-picker UI (mirrors the shape of
// proposals KNOWN_TOKENS; `status.*` and `recipient.*` ride the
// MergeContext free-form scopes).
export const STATUS_NOTIFICATION_TOKENS: TokenEntry[] = [
  { token: 'client.name', scope: 'client', description: "Client's legal name" },
  { token: 'firm.name', scope: 'firm', description: 'Firm name' },
  { token: 'firm.displayName', scope: 'firm', description: 'Firm display/brand name' },
  { token: 'firm.logo_url', scope: 'firm', description: 'Firm logo image URL' },
  { token: 'firm.support_email', scope: 'firm', description: 'Support email address' },
  { token: 'firm.support_phone', scope: 'firm', description: 'Support phone number' },
  { token: 'engagement.name', scope: 'engagement', description: 'Engagement name' },
  { token: 'status.label', scope: 'meta', description: 'Status label (staff-facing)' },
  {
    token: 'status.client_label',
    scope: 'meta',
    description: 'Client-facing status label (falls back to the staff label)',
  },
  {
    token: 'status.client_description',
    scope: 'meta',
    description: 'Client-facing status description (may be empty)',
  },
  { token: 'recipient.name', scope: 'meta', description: "Recipient's name" },
  { token: 'today', scope: 'meta', description: "Today's date" },
];
