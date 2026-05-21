// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Email-in worker stub (Phase 22 #1). Polls an IMAP mailbox for new
// messages and converts them into draft time entries — useful for
// firms that want to capture work from email back-and-forth.
//
// This stub logs but does not connect to IMAP. Real wire-up requires
// MAIL_INBOUND_IMAP_HOST + MAIL_INBOUND_USERNAME + MAIL_INBOUND_PASSWORD
// env vars, then a node-imap or imapflow integration.

import type { Database } from '@vibe/db';

import type { Logger } from 'pino';

export async function runEmailIn(
  _db: Database,
  log: Logger,
): Promise<{ scanned: number; converted: number }> {
  const host = process.env['MAIL_INBOUND_IMAP_HOST'];
  if (!host) {
    log.debug('email-in: MAIL_INBOUND_IMAP_HOST not configured, skipping');
    return { scanned: 0, converted: 0 };
  }
  // Real implementation: connect to IMAP, fetch UNSEEN, parse subject as
  // engagement id, parse body as description, hours via subject hashtag,
  // mark as DRAFT time-entry, then mark message as read.
  log.info({ host }, 'email-in: configured but stub — real IMAP polling pending');
  return { scanned: 0, converted: 0 };
}
