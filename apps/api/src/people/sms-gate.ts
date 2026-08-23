// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0224 — the one place that decides "may we text this person, and on which
// number". Every automated SMS path (reminders, status notifications,
// dunning, invoice/payment texts, voice→SMS fallback) goes through here so
// the opt-out cannot be bypassed by a site that forgot a guard. OTP /
// security codes are deliberately NOT gated (they are not automated
// marketing/reminder traffic and the person asked for them).

import { eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { persons } from '@vibe/db/schema';

/** Mobile first, then landline; '' and whitespace count as blank. */
export function pickSmsPhone(p: {
  mobile?: string | null;
  phone?: string | null;
  smsOptOut?: boolean | null;
}): string | null {
  if (p.smsOptOut) return null;
  const mobile = p.mobile?.trim();
  if (mobile) return mobile;
  const phone = p.phone?.trim();
  return phone || null;
}

/** Live check against the person row (not a snapshot). Unknown person →
 *  not opted out (the caller has a number from somewhere else). */
export async function isSmsOptedOut(
  db: Database,
  personId: string | null | undefined,
): Promise<boolean> {
  if (!personId) return false;
  const [row] = await db
    .select({ smsOptOut: persons.smsOptOut })
    .from(persons)
    .where(eq(persons.id, personId))
    .limit(1);
  return row?.smsOptOut ?? false;
}

/** Batch form for senders that fan out to many people. */
export async function smsOptedOutSet(
  db: Database,
  personIds: Array<string | null | undefined>,
): Promise<Set<string>> {
  const ids = [...new Set(personIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: persons.id, smsOptOut: persons.smsOptOut })
    .from(persons)
    .where(inArray(persons.id, ids));
  return new Set(rows.filter((r) => r.smsOptOut).map((r) => r.id));
}

/** Error code senders return when the person has a number but opted out —
 *  distinct from "no number on file" so the UI can explain it. */
export const SMS_OPTED_OUT = 'sms_opted_out' as const;
