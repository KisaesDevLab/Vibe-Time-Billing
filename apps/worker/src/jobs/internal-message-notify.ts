// SPDX-License-Identifier: Elastic-2.0
//
// internal-message-notify — fan out a "new message" email + SMS to the
// staff members of an internal thread who haven't caught up, debounced so a
// burst of messages is at most one notification per member per window.
//
// Generic copy only (sender name + a link); the message body is never put
// in an email/SMS. The in-app unread badge is the primary signal — this is
// the away-from-app nudge.

import { and, eq, isNull, ne, or, sql, gt, lt } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { appUsers, messages, threadMembers, threads } from '@vibe/db/schema';

import type { MailDispatch, SmsDispatch } from '../dispatchers';

const DEBOUNCE_MS = 5 * 60 * 1000;

export interface NotifyDeps {
  sendEmail?: MailDispatch;
  sendSms?: SmsDispatch;
  appBaseUrl?: string;
}

export interface NotifyResult {
  threadId: string;
  emailed: number;
  texted: number;
}

export async function runInternalMessageNotify(
  db: Database,
  log: Logger,
  payload: { threadId: string; messageId: string; firmId: string; senderAppUserId: string },
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const { threadId, firmId, senderAppUserId } = payload;

  const [thread] = await db
    .select({ id: threads.id, title: threads.title, firmId: threads.firmId, kind: threads.kind })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!thread || thread.firmId !== firmId || thread.kind !== 'internal') {
    return { threadId, emailed: 0, texted: 0 };
  }

  const [sender] = await db
    .select({ name: appUsers.fullName })
    .from(appUsers)
    .where(eq(appUsers.id, senderAppUserId))
    .limit(1);
  const senderName = sender?.name ?? 'A colleague';

  const now = Date.now();
  const debounceCutoff = new Date(now - DEBOUNCE_MS);

  // Candidate recipients: active members other than the sender, who have
  // unread messages (last_read_at < newest message or null) and weren't
  // notified within the debounce window.
  const recipients = await db
    .select({
      memberId: threadMembers.id,
      appUserId: threadMembers.appUserId,
      email: appUsers.email,
      mobilePhone: appUsers.mobilePhone,
      businessPhone: appUsers.businessPhone,
      lastReadAt: threadMembers.lastReadAt,
      lastNotifiedAt: threadMembers.lastNotifiedAt,
    })
    .from(threadMembers)
    .innerJoin(appUsers, eq(appUsers.id, threadMembers.appUserId))
    .where(
      and(
        eq(threadMembers.threadId, threadId),
        isNull(threadMembers.removedAt),
        ne(threadMembers.appUserId, senderAppUserId),
        eq(appUsers.status, 'ACTIVE'),
        or(isNull(threadMembers.lastNotifiedAt), lt(threadMembers.lastNotifiedAt, debounceCutoff)),
      ),
    );

  const label = thread.title ? `the "${thread.title}" group` : 'a direct message';
  const inbox = deps.appBaseUrl ? `${deps.appBaseUrl.replace(/\/$/, '')}/team` : null;
  const subject = `New message from ${senderName}`;
  const body =
    `${senderName} sent you ${label} in Vibe.` +
    (inbox ? `\n\nOpen your messages:\n${inbox}\n` : '') +
    `\n\n(Message content is shown only after you sign in.)`;

  let emailed = 0;
  let texted = 0;
  for (const r of recipients) {
    const uid = r.appUserId;
    if (!uid) continue; // staff members always have an app_user_id
    // Skip members who have already read everything (no unread).
    const [unread] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          isNull(messages.deletedAt),
          ne(messages.senderAppUserId, uid),
          r.lastReadAt ? gt(messages.createdAt, r.lastReadAt) : sql`true`,
        ),
      );
    if (Number(unread?.n ?? 0) === 0) continue;

    if (r.email && deps.sendEmail) {
      await deps.sendEmail({ to: r.email, subject, body }).then(
        () => {
          emailed += 1;
        },
        (err: unknown) => log.error({ err, threadId }, 'internal-message-notify: email failed'),
      );
    }
    const phone = r.mobilePhone ?? r.businessPhone;
    if (phone && deps.sendSms) {
      await deps
        .sendSms({
          to: phone,
          body: `${senderName} sent you a message in Vibe.${inbox ? ` ${inbox}` : ''}`,
        })
        .then(
          () => {
            texted += 1;
          },
          (err: unknown) => log.error({ err, threadId }, 'internal-message-notify: sms failed'),
        );
    }
    await db
      .update(threadMembers)
      .set({ lastNotifiedAt: new Date() })
      .where(eq(threadMembers.id, r.memberId));
  }

  return { threadId, emailed, texted };
}
