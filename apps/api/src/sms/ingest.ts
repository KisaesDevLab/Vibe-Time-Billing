// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Inbound SMS ingestion types (Phase 3 stub; implementation lands in
// Phase 4). Shared by the webhook router, the polling reconciler, and the
// legacy appointment webhook alias.

import type { Logger } from 'pino';

import type { Database } from '@vibe/db';

import type { SmsEvent } from './send-service';

export interface InboundSms {
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  media: Array<{ url: string; contentType: string; sid?: string }>;
  optOutType?: string | null;
  providerStatus?: string;
  providerTimestamp?: Date | null;
}

export interface IngestDeps {
  db: Database;
  log: Logger;
  now?: () => Date;
  publish?: (evt: SmsEvent) => Promise<void> | void;
}

export type IngestResult =
  | { status: 'created'; messageId: string; conversationId: string; firmId: string }
  | { status: 'duplicate'; messageId: string; conversationId: string; firmId: string }
  | { status: 'no_line' };
