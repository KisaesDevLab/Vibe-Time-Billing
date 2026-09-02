// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — indexed phone → person lookup for the SMS inbox. Replaces the
// appointment webhook's 500-row JS scan: person.phone_e164 / mobile_e164
// are trigger-maintained and partially indexed per firm. Zod-free.

import { and, eq, or } from 'drizzle-orm';

import { normalizePhone } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import { clientContacts, clients, persons } from '@vibe/db/schema';

export interface PersonPhoneMatch {
  personId: string;
  fullName: string;
  smsOptOut: boolean;
  smsConsentAt: Date | null;
  /** ACTIVE client contacts for this person (may be empty). */
  clients: Array<{ clientId: string; clientName: string; clientContactId: string }>;
}

/** Best-effort E.164; null when the input can't be normalized. */
export function toE164OrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return normalizePhone(raw);
}

/**
 * Every ACTIVE person in the firm whose phone or mobile normalizes to
 * `e164`, with their ACTIVE client contacts. Shared numbers are legitimate
 * (spouses, office lines) so callers decide what "one match" means.
 */
export async function findPersonsByE164(
  db: Database,
  firmId: string,
  e164: string,
): Promise<PersonPhoneMatch[]> {
  const rows = await db
    .select({
      personId: persons.id,
      fullName: persons.fullName,
      smsOptOut: persons.smsOptOut,
      smsConsentAt: persons.smsConsentAt,
      clientContactId: clientContacts.id,
      clientId: clientContacts.clientId,
      contactStatus: clientContacts.status,
      clientName: clients.name,
      clientStatus: clients.status,
    })
    .from(persons)
    .leftJoin(clientContacts, eq(clientContacts.personId, persons.id))
    .leftJoin(clients, eq(clients.id, clientContacts.clientId))
    .where(
      and(
        eq(persons.firmId, firmId),
        eq(persons.status, 'ACTIVE'),
        or(eq(persons.mobileE164, e164), eq(persons.phoneE164, e164)),
      ),
    );
  const byPerson = new Map<string, PersonPhoneMatch>();
  for (const r of rows) {
    let m = byPerson.get(r.personId);
    if (!m) {
      m = {
        personId: r.personId,
        fullName: r.fullName,
        smsOptOut: r.smsOptOut,
        smsConsentAt: r.smsConsentAt,
        clients: [],
      };
      byPerson.set(r.personId, m);
    }
    if (
      r.clientContactId &&
      r.clientId &&
      r.contactStatus === 'ACTIVE' &&
      r.clientStatus !== 'ARCHIVED' &&
      !m.clients.some((c) => c.clientId === r.clientId)
    ) {
      m.clients.push({
        clientId: r.clientId,
        clientName: r.clientName ?? '',
        clientContactId: r.clientContactId,
      });
    }
  }
  return [...byPerson.values()];
}
