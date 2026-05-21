// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
import { clientContacts } from '@vibe/db/schema';

export interface BillingContactSnapshot {
  fullName: string;
  email: string | null;
  phone: string | null;
}

export async function getBillingContact(
  db: Database,
  clientId: string,
): Promise<BillingContactSnapshot | null> {
  // Single round-trip: fetch up to 2 rows ordered so isBilling wins,
  // then isPrimary. (Drizzle doesn't expose a CASE-WHEN order easily;
  // a two-step fetch keeps it simple and the table is small per client.)
  const billing = await db
    .select({
      fullName: clientContacts.fullName,
      email: clientContacts.email,
      phone: clientContacts.phone,
    })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isBilling, true)))
    .limit(1);
  if (billing[0]) return billing[0];

  const primary = await db
    .select({
      fullName: clientContacts.fullName,
      email: clientContacts.email,
      phone: clientContacts.phone,
    })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isPrimary, true)))
    .limit(1);
  return primary[0] ?? null;
}
