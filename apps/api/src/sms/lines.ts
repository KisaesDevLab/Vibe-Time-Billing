// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — sms_line maintenance shared by the settings routes, the send
// service (first-send auto-sync) and inbound ingestion (auto-discover).
// Zod-free so the worker can import it.

import { and, asc, eq } from 'drizzle-orm';

import { normalizePhone } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import { smsLines } from '@vibe/db/schema';

/**
 * Upsert the Messaging Service's numbers into sms_line: new numbers are
 * added (ingest on), numbers no longer in the service are archived, and
 * the first line becomes the default when the firm has none. Exported for
 * the inbound path's "auto-discover" case and tests.
 */
export async function syncLines(
  db: Database,
  firmId: string,
  numbers: Array<{ sid: string; phoneNumber: string }>,
  now: Date,
): Promise<{ added: number; archived: number; total: number }> {
  const wanted = new Map<string, string>(); // e164 → sid
  for (const n of numbers) {
    const e164 = normalizePhone(n.phoneNumber) ?? n.phoneNumber;
    if (e164) wanted.set(e164, n.sid);
  }
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(smsLines).where(eq(smsLines.firmId, firmId));
    const byNumber = new Map(existing.map((l) => [l.phoneNumberE164, l]));
    let added = 0;
    let archived = 0;
    for (const [e164, sid] of wanted) {
      const cur = byNumber.get(e164);
      if (!cur) {
        await tx.insert(smsLines).values({
          firmId,
          phoneNumberE164: e164,
          twilioSid: sid,
          label: null,
          ingest: true,
          isDefault: false,
        });
        added += 1;
      } else if (cur.status !== 'ACTIVE' || cur.twilioSid !== sid) {
        await tx
          .update(smsLines)
          .set({ status: 'ACTIVE', twilioSid: sid, updatedAt: now })
          .where(eq(smsLines.id, cur.id));
      }
    }
    for (const l of existing) {
      if (l.status === 'ACTIVE' && !wanted.has(l.phoneNumberE164)) {
        await tx
          .update(smsLines)
          .set({ status: 'ARCHIVED', isDefault: false, ingest: false, updatedAt: now })
          .where(eq(smsLines.id, l.id));
        archived += 1;
      }
    }
    const active = await tx
      .select({ id: smsLines.id, isDefault: smsLines.isDefault })
      .from(smsLines)
      .where(and(eq(smsLines.firmId, firmId), eq(smsLines.status, 'ACTIVE')))
      .orderBy(asc(smsLines.createdAt), asc(smsLines.phoneNumberE164));
    if (active.length > 0 && !active.some((l) => l.isDefault)) {
      await tx
        .update(smsLines)
        .set({ isDefault: true, updatedAt: now })
        .where(eq(smsLines.id, active[0]!.id));
    }
    return { added, archived, total: active.length };
  });
}
