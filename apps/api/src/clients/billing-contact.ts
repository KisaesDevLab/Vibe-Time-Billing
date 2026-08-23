// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Resolve a client's billing contact details. In v1 these lived on
// client.billing_contact_*; v2 0027 moved them into one-to-many
// client_contact rows (workstream 1.2). All call sites that used to
// read client.billingContactEmail / Phone go through this helper.
//
// Resolution order:
//   1. Contact with isBilling = true (uniquely enforced per client)
//   2. Contact with isPrimary = true (fallback)
//   3. null (the client has no contacts — unlikely after the 0027
//      backfill but the helper is defensive)

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientContacts, persons } from '@vibe/db/schema';

export interface BillingContactSnapshot {
  fullName: string;
  email: string | null;
  phone: string | null;
  /** 0224 — number to TEXT: mobile first, then phone; null when the person
   *  opted out of automated texts. Use this for any SMS send. */
  smsPhone: string | null;
}

// 0115 — name/email/phone are canonical on `person`; the billing/primary
// precedence flags stay per-client on client_contact. The return shape is
// unchanged so all consumers (invoices, AR, statements, engagement
// letters, dunning, retainer reminders) keep working without edits.
async function pick(
  db: Database,
  clientId: string,
  flag: typeof clientContacts.isBilling | typeof clientContacts.isPrimary,
): Promise<BillingContactSnapshot | null> {
  const [row] = await db
    .select({
      fullName: persons.fullName,
      email: persons.email,
      phone: persons.phone,
      mobile: persons.mobile,
      smsOptOut: persons.smsOptOut,
    })
    .from(clientContacts)
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(and(eq(clientContacts.clientId, clientId), eq(flag, true)))
    .limit(1);
  if (!row) return null;
  return {
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    smsPhone: row.smsOptOut ? null : (row.mobile ?? row.phone),
  };
}

export async function getBillingContact(
  db: Database,
  clientId: string,
): Promise<BillingContactSnapshot | null> {
  return (
    (await pick(db, clientId, clientContacts.isBilling)) ??
    (await pick(db, clientId, clientContacts.isPrimary))
  );
}

/** Convenience: the billing/primary contact's email (null if none). */
export async function getBillingContactEmail(
  db: Database,
  clientId: string,
): Promise<string | null> {
  return (await getBillingContact(db, clientId))?.email ?? null;
}
