// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Association engine (addendum §3). Runs on every inbound insert and on
// demand ("Re-run matching"); idempotent. Precedence:
//   1. manual link — never overridden
//   2. reply-to-context — an outbound to this number in the last 14 days
//      carrying an appointment / booking / client-request / engagement
//   3. phone match — person.mobile_e164 / phone_e164 → their ACTIVE
//      client contact(s). One person → link (+ suggest the client's only
//      ACTIVE engagement); several → needs_triage with candidates.
// Zod-free: the worker's polling reconciler runs it too.

import { and, count, desc, eq, gt, isNotNull, or } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appointments,
  clientContacts,
  clientRequests,
  engagements,
  smsConversations,
  smsMessages,
} from '@vibe/db/schema';

import { findPersonsByE164, type PersonPhoneMatch } from './lookup';

export const REPLY_CONTEXT_WINDOW_MS = 14 * 24 * 3600 * 1000;

export interface AssociationResult {
  method: 'manual' | 'existing' | 'reply_context' | 'phone_unique' | 'phone_multiple' | 'none';
  personId: string | null;
  clientContactId: string | null;
  clientId: string | null;
  engagementId: string | null;
  engagementSuggested: boolean;
  candidates: PersonPhoneMatch[];
}

async function singleActiveEngagement(db: Database, clientId: string): Promise<string | null> {
  const rows = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(and(eq(engagements.clientId, clientId), eq(engagements.status, 'ACTIVE')))
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Step 2 — derive client/engagement from a recent contextual outbound. */
async function replyContext(
  db: Database,
  firmId: string,
  number: string,
  now: Date,
): Promise<{
  clientId: string | null;
  engagementId: string | null;
  personId: string | null;
} | null> {
  const since = new Date(now.getTime() - REPLY_CONTEXT_WINDOW_MS);
  const [m] = await db
    .select({
      appointmentId: smsMessages.appointmentId,
      bookingRequestId: smsMessages.bookingRequestId,
      clientRequestId: smsMessages.clientRequestId,
      engagementId: smsMessages.engagementId,
    })
    .from(smsMessages)
    .where(
      and(
        eq(smsMessages.firmId, firmId),
        eq(smsMessages.direction, 'outbound'),
        eq(smsMessages.toE164, number),
        gt(smsMessages.createdAt, since),
        or(
          isNotNull(smsMessages.appointmentId),
          isNotNull(smsMessages.clientRequestId),
          isNotNull(smsMessages.engagementId),
        ),
      ),
    )
    .orderBy(desc(smsMessages.createdAt))
    .limit(1);
  if (!m) return null;
  if (m.engagementId) {
    const [e] = await db
      .select({ clientId: engagements.clientId })
      .from(engagements)
      .where(eq(engagements.id, m.engagementId))
      .limit(1);
    return { clientId: e?.clientId ?? null, engagementId: m.engagementId, personId: null };
  }
  if (m.clientRequestId) {
    const [r] = await db
      .select({ engagementId: clientRequests.engagementId })
      .from(clientRequests)
      .where(eq(clientRequests.id, m.clientRequestId))
      .limit(1);
    if (r?.engagementId) {
      const [e] = await db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, r.engagementId))
        .limit(1);
      return { clientId: e?.clientId ?? null, engagementId: r.engagementId, personId: null };
    }
  }
  if (m.appointmentId) {
    const [a] = await db
      .select({ clientId: appointments.clientId, engagementId: appointments.engagementId })
      .from(appointments)
      .where(eq(appointments.id, m.appointmentId))
      .limit(1);
    if (a?.clientId)
      return { clientId: a.clientId, engagementId: a.engagementId ?? null, personId: null };
  }
  return null;
}

/**
 * Compute the association for a conversation and persist it. Returns
 * what was applied. `force` re-runs even when a client is already linked
 * (but a manual link always wins).
 */
export async function associateConversation(
  db: Database,
  args: { conversationId: string; force?: boolean; now?: Date },
): Promise<AssociationResult> {
  const now = args.now ?? new Date();
  const [conv] = await db
    .select()
    .from(smsConversations)
    .where(eq(smsConversations.id, args.conversationId))
    .limit(1);
  const none: AssociationResult = {
    method: 'none',
    personId: null,
    clientContactId: null,
    clientId: null,
    engagementId: null,
    engagementSuggested: false,
    candidates: [],
  };
  if (!conv) return none;
  if (conv.linkSource === 'manual') {
    return {
      ...none,
      method: 'manual',
      personId: conv.personId,
      clientContactId: conv.clientContactId,
      clientId: conv.clientId,
      engagementId: conv.engagementId,
      engagementSuggested: conv.engagementSuggested,
    };
  }
  if (conv.clientId && !args.force) {
    return {
      ...none,
      method: 'existing',
      personId: conv.personId,
      clientContactId: conv.clientContactId,
      clientId: conv.clientId,
      engagementId: conv.engagementId,
      engagementSuggested: conv.engagementSuggested,
    };
  }

  const number = conv.externalNumberE164;
  const matches = await findPersonsByE164(db, conv.firmId, number);
  const withClients = matches.filter((m) => m.clients.length > 0);

  // Step 2 — reply context (client + engagement), person from phone if unique.
  const ctx = await replyContext(db, conv.firmId, number, now);
  if (ctx?.clientId) {
    const person =
      matches.length === 1
        ? matches[0]!
        : (withClients.find((m) => m.clients.some((c) => c.clientId === ctx.clientId)) ?? null);
    const contact = person?.clients.find((c) => c.clientId === ctx.clientId) ?? null;
    const engagementId = ctx.engagementId ?? (await singleActiveEngagement(db, ctx.clientId));
    const suggested = !ctx.engagementId && Boolean(engagementId);
    await db
      .update(smsConversations)
      .set({
        personId: person?.personId ?? conv.personId,
        clientContactId: contact?.clientContactId ?? null,
        clientId: ctx.clientId,
        engagementId,
        engagementSuggested: suggested,
        linkSource: 'reply_context',
        needsTriage: false,
        candidatePersonIds: [],
        updatedAt: now,
      })
      .where(eq(smsConversations.id, conv.id));
    return {
      method: 'reply_context',
      personId: person?.personId ?? conv.personId,
      clientContactId: contact?.clientContactId ?? null,
      clientId: ctx.clientId,
      engagementId,
      engagementSuggested: suggested,
      candidates: [],
    };
  }

  // Step 3 — phone match.
  if (withClients.length === 1 && withClients[0]!.clients.length === 1) {
    const person = withClients[0]!;
    const client = person.clients[0]!;
    const engagementId = await singleActiveEngagement(db, client.clientId);
    await db
      .update(smsConversations)
      .set({
        personId: person.personId,
        clientContactId: client.clientContactId,
        clientId: client.clientId,
        engagementId,
        engagementSuggested: Boolean(engagementId),
        linkSource: 'phone',
        needsTriage: false,
        candidatePersonIds: [],
        updatedAt: now,
      })
      .where(eq(smsConversations.id, conv.id));
    return {
      method: 'phone_unique',
      personId: person.personId,
      clientContactId: client.clientContactId,
      clientId: client.clientId,
      engagementId,
      engagementSuggested: Boolean(engagementId),
      candidates: [],
    };
  }
  if (withClients.length > 0) {
    // Several people (or one person on several clients) share the number.
    await db
      .update(smsConversations)
      .set({
        personId: withClients.length === 1 ? withClients[0]!.personId : conv.personId,
        needsTriage: true,
        candidatePersonIds: withClients.map((m) => m.personId),
        updatedAt: now,
      })
      .where(eq(smsConversations.id, conv.id));
    return {
      ...none,
      method: 'phone_multiple',
      personId: withClients.length === 1 ? withClients[0]!.personId : null,
      candidates: withClients,
    };
  }
  if (matches.length === 1) {
    // Known person, no client link — remember who they are anyway.
    await db
      .update(smsConversations)
      .set({ personId: matches[0]!.personId, updatedAt: now })
      .where(eq(smsConversations.id, conv.id));
    return { ...none, personId: matches[0]!.personId };
  }
  return none;
}

/** How many ACTIVE contacts a client has — exported for tests/UI hints. */
export async function activeContactCount(db: Database, clientId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.status, 'ACTIVE')));
  return Number(r?.n ?? 0);
}
