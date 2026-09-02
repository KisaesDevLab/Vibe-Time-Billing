// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared client-side types for the two-way SMS inbox (0233+). Mirrors the
// JSON shapes served by apps/api/src/sms/*.

export type SmsA2pStatus = 'unknown' | 'unregistered' | 'pending' | 'registered' | 'not_applicable';

export interface SmsLine {
  id: string;
  phoneNumberE164: string;
  twilioSid: string | null;
  label: string | null;
  defaultAssigneeUserId: string | null;
  defaultAssigneeName: string | null;
  ingest: boolean;
  isDefault: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
  pollCursorAt: string | null;
  lastPolledAt: string | null;
}

export interface SmsInboxSettings {
  enabled: boolean;
  providerReady: boolean;
  messagingServiceSid: string | null;
  publicBaseUrl: string | null;
  effectivePublicBaseUrl: string;
  publicBaseUrlSource: 'firm' | 'public_base_url' | 'app_base_url';
  webhookUrls: { inbound: string; status: string };
  pollIntervalMinutes: number;
  retentionUnassignedDays: number;
  retentionSpamDays: number;
  defaultWorkCodeId: string | null;
  piiWarningsEnabled: boolean;
  consentEnforced: boolean;
  a2p: { status: SmsA2pStatus; checkedAt: string | null; overrideAllow: boolean };
}

export interface SmsHealth {
  configured: boolean;
  lastInboundWebhookAt: string | null;
  lastStatusWebhookAt: string | null;
  lastPollAt: string | null;
  lastSendAt: string | null;
  webhookGap: boolean;
  webhook?: {
    gapDetectedAt?: string | null;
    missedSincePoll?: number;
    invalidSignature24h?: number;
    matchedBase?: string | null;
  };
  poll?: { lastOk?: boolean; lastError?: string | null; linesPolled?: number };
  send?: { failures24h?: number; lastError?: string | null; deadLettered?: number };
  media?: { pending?: number; failed24h?: number };
  a2p?: { status?: SmsA2pStatus; checkedAt?: string | null };
  lines?: { autoDiscovered?: string[] };
}

// ----- Inbox (0234) ------------------------------------------------------

export type SmsFilter = 'unread' | 'unassigned' | 'triage' | 'mine' | 'all';
export type SmsConversationStatus = 'open' | 'closed' | 'spam';
export type SmsDirection = 'inbound' | 'outbound';
export type SmsProviderStatus =
  | 'queued'
  | 'accepted'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'received'
  | 'receiving'
  | 'canceled'
  | 'dead_letter';

export interface SmsConversation {
  id: string;
  lineId: string;
  lineLabel: string;
  externalNumberE164: string;
  contact: { personId: string; name: string; smsOptOut: boolean } | null;
  client: { id: string; name: string; restricted: boolean } | null;
  engagement: { id: string; name: string; suggested: boolean } | null;
  assignedUser: { id: string; name: string } | null;
  status: SmsConversationStatus;
  linkSource: 'none' | 'reply_context' | 'phone' | 'manual';
  needsTriage: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastMessagePreview: string;
  lastDirection: SmsDirection | null;
  pendingReschedule: boolean;
  createdAt: string;
}

export type SmsReplyBlockReason =
  | 'opted_out'
  | 'consent_required'
  | 'a2p_unregistered'
  | 'closed'
  | 'spam'
  | null;

export interface SmsConversationDetail extends SmsConversation {
  candidates: Array<{
    personId: string;
    name: string;
    clientId: string;
    clientName: string;
    clientContactId: string;
  }>;
  consent: { at: string | null; source: string | null };
  optOut: { active: boolean; at: string | null; source: string | null };
  inboundInitiated: boolean;
  canReply: boolean;
  replyBlockReason: SmsReplyBlockReason;
  piiWarningsEnabled: boolean;
  templateVars: Record<'client_first' | 'engagement_name' | 'staff_first' | 'firm', string | null>;
  engagementOptions: Array<{ id: string; name: string; status: string }>;
}

export interface SmsMediaItem {
  id: string;
  contentType: string | null;
  sizeBytes: number | null;
  status: 'pending' | 'stored' | 'intake' | 'failed';
  intakeSessionId: string | null;
  intakeFileId: string | null;
  url: string | null;
}

export interface SmsMessage {
  id: string;
  direction: SmsDirection;
  body: string;
  providerStatus: SmsProviderStatus;
  providerErrorCode: number | null;
  providerErrorMessage: string | null;
  numSegments: number | null;
  numMedia: number;
  contextKind: string;
  engagementId: string | null;
  sentBy: { id: string; name: string } | null;
  appointmentId: string | null;
  parsedIntent: 'confirm' | 'reschedule' | null;
  readAt: string | null;
  redactionFlags: string[];
  media: SmsMediaItem[];
  providerTimestamp: string | null;
  createdAt: string;
}

export interface SmsTemplate {
  id: string;
  name: string;
  body: string;
  scope: 'firm' | 'user';
  variables: string[];
}

export type SmsStreamEvent =
  | {
      type: 'sms.message.created';
      firmId: string;
      conversationId: string;
      messageId?: string;
      clientId?: string | null;
    }
  | {
      type: 'sms.message.status';
      firmId: string;
      conversationId: string;
      messageId?: string;
    }
  | { type: 'sms.conversation.updated'; firmId: string; conversationId: string }
  | { type: 'sms.refresh' };
