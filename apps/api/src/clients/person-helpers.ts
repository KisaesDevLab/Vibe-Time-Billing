// SPDX-License-Identifier: Elastic-2.0
//
// 0115 — firm-global person directory helpers. findOrCreatePerson is the
// single dedup chokepoint used by contacts CRUD, client import, and the
// portal-invite "add contact" flow. Always firm-scoped — a missing firm
// filter would silently merge two firms' people.

import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, QueryResultHKT } from 'drizzle-orm/pg-core';

import { persons } from '@vibe/db/schema';
import { normalizeEmail, normalizePhone } from '@vibe/core/auth';

// reason: drizzle's per-schema Tx generics aren't assignment-compatible
// across call sites; widen to the base PgDatabase like the seed helpers so
// both `db` and a `db.transaction(tx => …)` handle work.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<QueryResultHKT, any, any>;

export interface PersonInput {
  firmId: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
}

const digitsOnly = (s: string | null): string | null => {
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length ? d : null;
};

/**
 * Find an existing firm person by normalized email (preferred) or phone,
 * else create one. Returns the person id. Email is the canonical key;
 * phone is a fallback only when no email is present (shared numbers must
 * not merge distinct people).
 */
export async function findOrCreatePerson(db: Db, input: PersonInput): Promise<string> {
  const email = normalizeEmail(input.email ?? null);
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const mobile = input.mobile ? normalizePhone(input.mobile) : null;

  if (email) {
    const [hit] = await db
      .select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.firmId, input.firmId), sql`lower(${persons.email}) = ${email}`))
      .limit(1);
    if (hit) return hit.id;
  } else {
    const pd = digitsOnly(phone) ?? digitsOnly(mobile);
    if (pd) {
      const [hit] = await db
        .select({ id: persons.id })
        .from(persons)
        .where(
          and(
            eq(persons.firmId, input.firmId),
            sql`${persons.email} IS NULL`,
            sql`regexp_replace(coalesce(${persons.phone}, ${persons.mobile}), '\\D', '', 'g') = ${pd}`,
          ),
        )
        .limit(1);
      if (hit) return hit.id;
    }
  }

  const [created] = await db
    .insert(persons)
    .values({ firmId: input.firmId, fullName: input.fullName, email, phone, mobile })
    .onConflictDoNothing()
    .returning({ id: persons.id });
  if (created) return created.id;

  // Lost a race on the (firm, lower(email)) unique index — re-select.
  if (email) {
    const [hit] = await db
      .select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.firmId, input.firmId), sql`lower(${persons.email}) = ${email}`))
      .limit(1);
    if (hit) return hit.id;
  }
  throw new Error('person_upsert_failed');
}

export interface PersonFieldUpdate {
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
}

/**
 * Update the canonical fields on a firm-global person. Only the keys
 * present (not `undefined`) are written, so it composes with partial
 * PATCH bodies. The shared person row is the single source of truth, so
 * this propagates to every client the person is a contact of.
 *
 * Email is stored as provided (the `(firm_id, lower(email))` unique index
 * still catches collisions case-insensitively); the caller is expected to
 * catch the resulting DB error and surface a 409.
 */
export async function updatePerson(
  db: Db,
  personId: string,
  input: PersonFieldUpdate,
): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (input.fullName !== undefined) fields['fullName'] = input.fullName;
  if (input.email !== undefined) fields['email'] = input.email;
  if (input.phone !== undefined) fields['phone'] = input.phone;
  if (input.mobile !== undefined) fields['mobile'] = input.mobile;
  if (Object.keys(fields).length === 0) return;
  fields['updatedAt'] = new Date();
  await db.update(persons).set(fields).where(eq(persons.id, personId));
}
