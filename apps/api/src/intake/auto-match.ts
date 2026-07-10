// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Auto-match: given a (decrypted) intake submitter's email/phone/name,
// suggest the existing clients it most likely belongs to. Pure ranking
// over client_contact (email/phone/name) + client.name. The staff member
// always confirms — this only seeds the disposition picker.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientContacts, clients, persons } from '@vibe/db/schema';

export interface MatchInput {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
}

export interface ClientMatch {
  clientId: string;
  clientName: string;
  score: number;
  reasons: string[];
}

const digits = (s: string): string => s.replace(/\D/g, '');
const norm = (s: string): string => s.trim().toLowerCase();

function nameOverlap(a: string, b: string): number {
  const ta = new Set(norm(a).split(/\s+/).filter(Boolean));
  const tb = new Set(norm(b).split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

export async function suggestClients(
  db: Database,
  firmId: string,
  input: MatchInput,
  limit = 5,
): Promise<ClientMatch[]> {
  const email = input.email ? norm(input.email) : null;
  const phoneDigits = input.phone ? digits(input.phone).slice(-10) : null;
  const name = input.name ? norm(input.name) : null;

  // Pull active clients + their contacts (single firm; sets are small).
  const contactRows = await db
    // 0115 — name/email/phone are canonical on person.
    .select({
      clientId: clientContacts.clientId,
      clientName: clients.name,
      email: persons.email,
      phone: persons.phone,
      fullName: persons.fullName,
    })
    .from(clientContacts)
    .innerJoin(clients, eq(clients.id, clientContacts.clientId))
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(and(eq(clients.firmId, firmId), eq(clients.status, 'ACTIVE')));

  const clientRows = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.firmId, firmId), eq(clients.status, 'ACTIVE')));

  const byClient = new Map<string, ClientMatch>();
  const bump = (clientId: string, clientName: string, score: number, reason: string): void => {
    const cur = byClient.get(clientId) ?? { clientId, clientName, score: 0, reasons: [] };
    cur.score += score;
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    byClient.set(clientId, cur);
  };

  for (const c of contactRows) {
    if (email && c.email && norm(c.email) === email) bump(c.clientId, c.clientName, 100, 'email');
    if (phoneDigits && c.phone && digits(c.phone).slice(-10) === phoneDigits) {
      bump(c.clientId, c.clientName, 80, 'phone');
    }
    if (name && c.fullName) {
      const ov = nameOverlap(name, c.fullName);
      if (ov >= 0.5) bump(c.clientId, c.clientName, Math.round(40 * ov), 'contact name');
    }
  }

  if (name) {
    for (const c of clientRows) {
      const ov = nameOverlap(name, c.name);
      if (ov >= 0.5) bump(c.id, c.name, Math.round(30 * ov), 'client name');
    }
  }

  return Array.from(byClient.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
