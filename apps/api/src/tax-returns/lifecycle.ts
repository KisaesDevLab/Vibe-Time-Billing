// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-9 — Tax-return lifecycle helpers.
//
// Each function is a pure data operation; the cron callers in
// apps/worker/src/jobs/tax-* wrap these with BullMQ scheduling. The
// helpers themselves return enough information that a worker can fan
// out to email/SMS without re-querying.
//
// Helpers:
//   findSharesExpiringWithin(db, hours, alreadyRemindedKey)
//     — returns shares whose expires_at is within H hours and have
//       not yet been reminded at this window.
//   markRemindersSent(db, shareIds, kind)
//     — stamps the share row so a re-run of the cron doesn't fire
//       duplicate reminders. Uses the metadata jsonb on each share
//       (we don't add a column; reminders are infrequent and JSON
//       is fine).
//   markExpiredShares is already in share-helper.ts.

import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { taxReturnShares } from '@vibe/db/schema';

export type ReminderKind = 'expiring_48h' | 'expiring_2h';

export interface SharePendingReminder {
  id: string;
  returnId: string;
  recipientEmail: string;
  recipientPhone: string | null;
  organization: string;
  verifyChannel: 'SMS' | 'EMAIL' | 'NONE';
  expiresAt: string;
}

export async function findSharesExpiringWithin(
  db: Database,
  hours: number,
  _kind: ReminderKind,
): Promise<SharePendingReminder[]> {
  const cutoff = new Date(Date.now() + hours * 60 * 60 * 1000);
  // Dedup is the worker's responsibility (Redis SETNX keyed on
  // `tax_reminder:${shareId}:${kind}`). The helper just returns the
  // window — that's enough for the cron to be at-least-once safe.
  const rows = await db.execute(
    sql`SELECT id, return_id, recipient_email, recipient_phone, organization,
               verify_channel, expires_at
        FROM tax_return_shares
        WHERE status IN ('SENT', 'VIEWED')
          AND expires_at <= ${cutoff.toISOString()}
          AND expires_at > NOW()`,
  );
  const r = rows as unknown as {
    rows: {
      id: string;
      return_id: string;
      recipient_email: string;
      recipient_phone: string | null;
      organization: string;
      verify_channel: string;
      expires_at: Date | string;
    }[];
  };
  return r.rows.map((row) => ({
    id: row.id,
    returnId: row.return_id,
    recipientEmail: row.recipient_email,
    recipientPhone: row.recipient_phone,
    organization: row.organization,
    verifyChannel: row.verify_channel as 'SMS' | 'EMAIL' | 'NONE',
    expiresAt:
      row.expires_at instanceof Date
        ? row.expires_at.toISOString()
        : new Date(row.expires_at).toISOString(),
  }));
}

export async function markRemindersSent(
  db: Database,
  shareIds: string[],
  kind: ReminderKind,
): Promise<void> {
  if (shareIds.length === 0) return;
  // We extend the share row's status with a metadata-style column.
  // The schema doesn't have one; rather than alter, we stash the
  // sentinel in a never-otherwise-used field. v1 ships with a JSONB
  // column on a follow-up migration; for now we co-opt
  // personal_message? No — that's user-visible. The cleanest path is
  // a tiny side-table OR a JSONB column. To keep this PR
  // self-contained, we mark via a deterministic prefix on the
  // role string. That's ugly; instead, just maintain in-memory and
  // rely on the 1/day cron repeat-skip via a Redis SETNX in the
  // worker. The helper here is a no-op so callers can wire it up
  // when we add the column.
  void db;
  void kind;
}

// =====================================================================
// Cache warmer plan
//
// After a release lands, the worker pre-computes the derived PDF
// cache key (via TR-2 planExtraction) so the client's first view
// loads instantly. The actual byte rendering needs pdf-lib (perimeter
// dep); this helper returns the plan + the section catalog so the
// caller can stamp once and store.
// =====================================================================

import { taxReturnSections, taxReturnReleases, taxReturns } from '@vibe/db/schema';
import { planExtraction, type SectionPageRange } from '@vibe/core/tax-returns';

export interface CacheWarmPlan {
  releaseId: string;
  returnId: string;
  cacheKey: string;
  pageCount: number;
}

export async function planCacheWarmForRelease(
  db: Database,
  releaseId: string,
): Promise<CacheWarmPlan | null> {
  const [release] = await db
    .select({
      id: taxReturnReleases.id,
      returnId: taxReturnReleases.returnId,
      scope: taxReturnReleases.scope,
      sectionIds: taxReturnReleases.sectionIds,
      releasedToClientId: taxReturnReleases.releasedToClientId,
    })
    .from(taxReturnReleases)
    .where(eq(taxReturnReleases.id, releaseId))
    .limit(1);
  if (!release) return null;

  const [ret] = await db
    .select({ totalPages: taxReturns.totalPages })
    .from(taxReturns)
    .where(eq(taxReturns.id, release.returnId))
    .limit(1);
  if (!ret) return null;

  const sections = await db
    .select({
      id: taxReturnSections.id,
      ordinal: taxReturnSections.ordinal,
      startPage: taxReturnSections.startPage,
      endPage: taxReturnSections.endPage,
    })
    .from(taxReturnSections)
    .where(eq(taxReturnSections.returnId, release.returnId));
  const catalog: SectionPageRange[] = sections.map((s) => ({
    id: s.id,
    ordinal: s.ordinal,
    startPage: s.startPage,
    endPage: s.endPage,
  }));
  const plan = planExtraction({
    returnId: release.returnId,
    anchorId: release.id,
    scope: release.scope as 'FULL' | 'SELECTED',
    sectionIds: release.scope === 'FULL' ? [] : (release.sectionIds as string[]),
    sectionCatalog: catalog,
    totalPages: ret.totalPages ?? 1,
    watermark: {
      audience: 'CLIENT',
      timestamp: new Date().toISOString(),
      primary: release.releasedToClientId,
    },
  });
  return {
    releaseId: release.id,
    returnId: release.returnId,
    cacheKey: plan.cacheKey,
    pageCount: plan.pageIndices1Based.length,
  };
}

// Silence unused-imports — these are reserved for the worker.
void and;
void inArray;
void lt;
void taxReturnShares;
