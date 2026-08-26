// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Intake "new submission" staff notification. Consumer.
//
// The worker's intake-process job finishes a session (scan → 'received')
// and enqueues one job here. Composition runs in the API process because
// the submitter's name / email / phone / message live in the session's
// *_enc columns, and only this process holds the firm key manager — the
// worker deliberately holds no firm key, so it can only send generic copy.
//
// Delivery never blocks on the details: if the appliance is locked or a
// column won't decrypt, the notification still goes out with the generic
// body the worker used to send.
//
// Note the privacy trade-off: the email now carries the submitter's name
// and contact details off the appliance through the firm's mail/SMS
// provider. The link + "sign in for the rest" framing is unchanged.

import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, intakeSessions, intakeStaffCards } from '@vibe/db/schema';

import { getApplianceLockState } from '../crypto/boot';
import { logger } from '../logger';
import { unwrapIntakeRecordKey, decField } from './crypto';

export const INTAKE_NOTIFY_QUEUE = 'intake-notify';

export interface IntakeNotifyJob {
  sessionId: string;
  firmId: string;
  /** Uploads that passed the scan; 0 for a message-only submission. */
  fileCount: number;
}

export interface IntakeNotifyDeps {
  db: Database | null;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
  /** Base URL of the staff app, for the inbox deep link. */
  appBaseUrl?: string;
}

export interface IntakeSubmitterDetails {
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
}

/** How much of a free-text message to quote before trimming. */
const MESSAGE_PREVIEW_CHARS = 300;

/**
 * Email + SMS copy for one arrival. Exported for tests: the body is the
 * whole point of the job, and it must degrade cleanly to the generic
 * version when no details could be decrypted.
 */
export function composeIntakeNotification(args: {
  fileCount: number;
  inboxUrl: string | null;
  details: IntakeSubmitterDetails | null;
}): { subject: string; body: string; sms: string } {
  const { fileCount, inboxUrl, details } = args;
  const what =
    fileCount === 0
      ? 'a message'
      : `${fileCount} file${fileCount === 1 ? '' : 's'}${details?.message ? ' and a message' : ''}`;
  const from = details?.name?.trim() || null;

  const subject = from
    ? `New document submission from ${from}`
    : 'New document submission received';

  const lines: string[] = [
    from
      ? `${from} sent you ${what} through your intake page.`
      : `You have a new document submission (${what}) waiting in your Intake inbox.`,
  ];

  // Contact block — what staff need to call or write back without first
  // signing in. Omitted entirely when nothing decrypted.
  const contact: string[] = [];
  if (details?.name?.trim()) contact.push(`Name:  ${details.name.trim()}`);
  if (details?.email?.trim()) contact.push(`Email: ${details.email.trim()}`);
  if (details?.phone?.trim()) contact.push(`Phone: ${details.phone.trim()}`);
  if (contact.length > 0) lines.push('', ...contact);

  if (details?.message?.trim()) {
    const msg = details.message.trim();
    const preview =
      msg.length > MESSAGE_PREVIEW_CHARS ? `${msg.slice(0, MESSAGE_PREVIEW_CHARS)}…` : msg;
    lines.push('', 'Message:', preview);
  }

  if (inboxUrl) lines.push('', `Open the inbox to review and file it:`, inboxUrl);
  else lines.push('', 'Open the Intake inbox to review and file it.');

  lines.push('', 'Files and any remaining details are shown only after you sign in.');

  // SMS stays one line — a text lands on a lock screen, so it names the
  // sender and one way to reach them, nothing more.
  const reach = details?.phone?.trim() || details?.email?.trim() || null;
  const sms = from
    ? `New intake submission from ${from}${reach ? ` (${reach})` : ''} in your Intake inbox.`
    : 'New document submission in your Intake inbox.';

  return { subject, body: lines.join('\n'), sms };
}

/** Decrypt the submitter's details, or null when they're unavailable. */
async function loadDetails(
  db: Database,
  firmId: string,
  sessionId: string,
): Promise<IntakeSubmitterDetails | null> {
  const lock = getApplianceLockState();
  if (lock.kind !== 'unlocked' || lock.firmId !== firmId) return null;
  const [row] = await db
    .select({
      wrappedDek: intakeSessions.wrappedDek,
      clientNameEnc: intakeSessions.clientNameEnc,
      clientEmailEnc: intakeSessions.clientEmailEnc,
      clientPhoneEnc: intakeSessions.clientPhoneEnc,
      messageEnc: intakeSessions.messageEnc,
    })
    .from(intakeSessions)
    .where(and(eq(intakeSessions.id, sessionId), eq(intakeSessions.firmId, firmId)))
    .limit(1);
  if (!row) return null;
  try {
    const dek = unwrapIntakeRecordKey(db, firmId, row.wrappedDek);
    return {
      name: decField(dek, row.clientNameEnc),
      email: decField(dek, row.clientEmailEnc),
      phone: decField(dek, row.clientPhoneEnc),
      message: decField(dek, row.messageEnc),
    };
  } catch (err) {
    logger.warn({ err, sessionId }, 'intake-notify: could not decrypt submitter details');
    return null;
  }
}

/** The unit of work; exported so tests can drive it without BullMQ. */
export async function processIntakeNotifyJob(
  deps: IntakeNotifyDeps,
  job: IntakeNotifyJob,
): Promise<'sent' | 'skipped'> {
  const db = deps.db;
  if (!db) return 'skipped';

  const [card] = await db
    .select({
      notifyEmail: intakeStaffCards.notifyEmail,
      notifySms: intakeStaffCards.notifySms,
      email: appUsers.email,
      mobilePhone: appUsers.mobilePhone,
      businessPhone: appUsers.businessPhone,
    })
    .from(intakeSessions)
    .innerJoin(
      intakeStaffCards,
      and(
        eq(intakeStaffCards.userId, intakeSessions.targetStaffId),
        eq(intakeStaffCards.firmId, intakeSessions.firmId),
      ),
    )
    .innerJoin(appUsers, eq(appUsers.id, intakeStaffCards.userId))
    .where(and(eq(intakeSessions.id, job.sessionId), eq(intakeSessions.firmId, job.firmId)))
    .limit(1);
  if (!card) return 'skipped';

  const details = await loadDetails(db, job.firmId, job.sessionId);
  const inboxUrl = deps.appBaseUrl ? `${deps.appBaseUrl.replace(/\/$/, '')}/intake` : null;
  const { subject, body, sms } = composeIntakeNotification({
    fileCount: job.fileCount,
    inboxUrl,
    details,
  });

  let sent = false;
  if (card.notifyEmail && card.email && deps.sendEmail) {
    try {
      await deps.sendEmail({ to: card.email, subject, body });
      sent = true;
    } catch (err) {
      logger.error({ err, sessionId: job.sessionId }, 'intake-notify: email failed');
    }
  }
  if (card.notifySms && deps.sendSms) {
    const phone = card.mobilePhone ?? card.businessPhone;
    if (phone) {
      try {
        await deps.sendSms({ to: phone, body: sms });
        sent = true;
      } catch (err) {
        logger.error({ err, sessionId: job.sessionId }, 'intake-notify: SMS failed');
      }
    }
  }
  return sent ? 'sent' : 'skipped';
}

export function startIntakeNotifyConsumer(deps: IntakeNotifyDeps): Worker<IntakeNotifyJob> | null {
  const url = process.env['REDIS_URL'] ?? null;
  if (!url || process.env['INTAKE_NOTIFY_CONSUMER'] === '0' || process.env['NODE_ENV'] === 'test') {
    return null;
  }
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const worker = new Worker<IntakeNotifyJob>(
    INTAKE_NOTIFY_QUEUE,
    async (job: Job<IntakeNotifyJob>) => {
      const outcome = await processIntakeNotifyJob(deps, job.data);
      logger.info({ sessionId: job.data.sessionId, outcome }, 'intake-notify job done');
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    logger.warn({ err, sessionId: job?.data.sessionId }, 'intake-notify job failed');
  });
  logger.info({ queue: INTAKE_NOTIFY_QUEUE }, 'intake-notify consumer started');
  return worker;
}
