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
