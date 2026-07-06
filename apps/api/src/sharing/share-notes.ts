// SPDX-License-Identifier: Elastic-2.0
//
// Client-timeline notes for file shares. When staff share a file with an
// outside party — and when that party later opens or downloads it — we drop
// a human-readable note on the client's record so the whole share lifecycle
// is visible in one place, alongside the audit log and share-event stream.
//
// client_note.author_id is NOT NULL and references app_user, so:
//   • the "shared" note is authored by the staff member who shared.
//   • the "accessed" note is authored by the share's creator (there is no
//     app_user for an external recipient); if the share had no app-user
//     creator (e.g. portal-initiated), the access note is skipped.

import type { Database } from '@vibe/db';
import { clientNotes } from '@vibe/db/schema';

import { logger } from '../logger';

function fmtExpiry(d?: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : 'when revoked';
}

function recipientLabel(name?: string | null, email?: string | null, org?: string | null): string {
  const parts = [name, email ? `<${email}>` : null, org ? `(${org})` : null].filter(Boolean);
  return parts.join(' ') || email || 'the recipient';
}

export interface ShareCreatedNoteInput {
  clientId: string | null;
  authorAppUserId: string;
  /** File name, or "3 files: a.pdf, b.pdf, c.pdf" for a bundle. */
  fileLabel: string;
  recipientName?: string | null;
  recipientEmail?: string | null;
  organization?: string | null;
  accessLevel: 'view' | 'download';
  watermark?: boolean;
  verifyChannel?: string | null;
  expiresAt?: Date | null;
  personalMessage?: string | null;
}

/** Note dropped on the client when a file is shared (all share-form info). */
export async function recordShareCreatedNote(
  db: Database,
  input: ShareCreatedNoteInput,
): Promise<void> {
  if (!input.clientId) return; // firm-level file with no client to attach to
  const codeLine =
    input.verifyChannel && input.verifyChannel !== 'NONE'
      ? ` · Access code via ${input.verifyChannel}`
      : '';
  const body = [
    `📤 File shared: ${input.fileLabel}`,
    `Recipient: ${recipientLabel(input.recipientName, input.recipientEmail, input.organization)}`,
    `Access: ${input.accessLevel === 'download' ? 'View & download' : 'View only'}` +
      ` · Expires ${fmtExpiry(input.expiresAt)}` +
      ` · Watermark ${input.watermark ? 'on' : 'off'}${codeLine}`,
    input.personalMessage ? `Message: "${input.personalMessage}"` : '',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    await db
      .insert(clientNotes)
      .values({ clientId: input.clientId, authorId: input.authorAppUserId, body, pinned: false });
  } catch (err) {
    logger.error({ err, clientId: input.clientId }, 'share-created client note insert failed');
  }
}

export interface ShareAccessNoteInput {
  clientId: string | null;
  /** Share creator (app_user). Access note is skipped when null. */
  authorAppUserId: string | null;
  fileLabel: string;
  recipientName?: string | null;
  recipientEmail?: string | null;
  action: 'viewed' | 'downloaded';
}

/** Note dropped on the client when the 3rd party opens/downloads the file. */
export async function recordShareAccessNote(
  db: Database,
  input: ShareAccessNoteInput,
): Promise<void> {
  if (!input.clientId || !input.authorAppUserId) return;
  const who = input.recipientEmail || input.recipientName || 'The recipient';
  const verb = input.action === 'downloaded' ? 'downloaded' : 'opened';
  const icon = input.action === 'downloaded' ? '⬇️' : '🔓';
  const body = `${icon} ${who} ${verb} the shared file: ${input.fileLabel}`;
  try {
    await db
      .insert(clientNotes)
      .values({ clientId: input.clientId, authorId: input.authorAppUserId, body, pinned: false });
  } catch (err) {
    logger.error({ err, clientId: input.clientId }, 'share-access client note insert failed');
  }
}
