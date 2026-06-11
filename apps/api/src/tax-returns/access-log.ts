// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-8 — Tax-return access-log helpers.
//
// The tax_return_access_log table is the append-only audit feed for
// the entire module. Every state-changing event AND every read
// touch from a client, staff impersonator, or share recipient lands
// here. Read endpoints (this file's listAccessLog / exportAccessLogCsv)
// serve both the client portal's "Access history" and the staff app's
// "Activity" tab.
//
// Pure helpers — no Express, no routing. Routes call into them.

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { csvField } from '../lib/csv';

import type { Database } from '@vibe/db';
import { taxReturnAccessLog, taxReturns } from '@vibe/db/schema';

export type TaxAccessActorKind = 'CLIENT' | 'STAFF' | 'RECIPIENT' | 'SYSTEM';

export type TaxAccessEventKind =
  | 'PARSED'
  | 'RELEASED'
  | 'REVOKED'
  | 'VIEW'
  | 'DOWNLOAD'
  | 'PAGE_RENDER'
  | '2FA_SENT'
  | '2FA_PASSED'
  | '2FA_FAILED'
  | 'EXPIRED'
  | 'SUPERSEDED'
  | 'SECTION_EDITED'
  | 'SHARED';

export interface AppendAccessLogInput {
  db: Database;
  returnId: string;
  event: TaxAccessEventKind;
  actorKind: TaxAccessActorKind;
  actorRef?: string | null;
  actorIp?: string | null;
  actorUserAgent?: string | null;
  shareId?: string | null;
  pageNumber?: number | null;
  sectionId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function appendAccessLog(input: AppendAccessLogInput): Promise<void> {
  await input.db.insert(taxReturnAccessLog).values({
    returnId: input.returnId,
    event: input.event,
    actorKind: input.actorKind,
    actorRef: input.actorRef ?? null,
    actorIp: input.actorIp ?? null,
    actorUserAgent: input.actorUserAgent ?? null,
    shareId: input.shareId ?? null,
    pageNumber: input.pageNumber ?? null,
    sectionId: input.sectionId ?? null,
    metadata: input.metadata ?? {},
  });
}

export interface ListAccessLogInput {
  db: Database;
  returnId: string;
  firmId: string;
  // Cursor: (at_iso, id) tuple; null for first page.
  cursor: { at: string; id: string } | null;
  pageSize: number;
  // When true, surface ONLY client-visible events (used by portal
  // route to filter out staff impersonation + parse events).
  clientVisibleOnly: boolean;
}

export interface AccessLogEntry {
  id: string;
  event: TaxAccessEventKind;
  actorKind: TaxAccessActorKind;
  actorRef: string | null;
  shareId: string | null;
  pageNumber: number | null;
  sectionId: string | null;
  metadata: Record<string, unknown>;
  at: string;
}

export interface ListAccessLogResult {
  items: AccessLogEntry[];
  nextCursor: { at: string; id: string } | null;
}

const STAFF_INTERNAL_EVENTS: TaxAccessEventKind[] = ['PARSED', 'SECTION_EDITED'];

export async function listAccessLog(input: ListAccessLogInput): Promise<ListAccessLogResult> {
  // Scope guard: verify the return belongs to the firm.
  const [ret] = await input.db
    .select({ id: taxReturns.id })
    .from(taxReturns)
    .where(and(eq(taxReturns.id, input.returnId), eq(taxReturns.firmId, input.firmId)))
    .limit(1);
  if (!ret) {
    return { items: [], nextCursor: null };
  }

  const conds = [eq(taxReturnAccessLog.returnId, input.returnId)];
  if (input.cursor) {
    // Pagination key: (at, id). Use the tuple-less form for portability —
    // strictly less-than on `at`. Falls back to id-tiebreak via secondary
    // sort. Good enough for v1 — exact tuple cursoring lands when we
    // partition the table.
    conds.push(lt(taxReturnAccessLog.at, new Date(input.cursor.at)));
  }

  const rows = await input.db
    .select()
    .from(taxReturnAccessLog)
    .where(and(...conds))
    .orderBy(desc(taxReturnAccessLog.at), desc(taxReturnAccessLog.id))
    .limit(input.pageSize + 1);
  const overflow = rows.length > input.pageSize;
  const trimmed = overflow ? rows.slice(0, input.pageSize) : rows;
  const filtered = input.clientVisibleOnly
    ? trimmed.filter((r) => !STAFF_INTERNAL_EVENTS.includes(r.event as TaxAccessEventKind))
    : trimmed;
  const items: AccessLogEntry[] = filtered.map((r) => ({
    id: r.id,
    event: r.event as TaxAccessEventKind,
    actorKind: r.actorKind as TaxAccessActorKind,
    actorRef: r.actorRef,
    shareId: r.shareId,
    pageNumber: r.pageNumber,
    sectionId: r.sectionId,
    metadata: r.metadata,
    at: r.at.toISOString(),
  }));
  const nextCursor = overflow
    ? {
        at: trimmed[trimmed.length - 1]!.at.toISOString(),
        id: trimmed[trimmed.length - 1]!.id,
      }
    : null;
  return { items, nextCursor };
}

// =====================================================================
// CSV export — staff-only. No rollup; one row per event verbatim.
// =====================================================================

function csvCell(raw: unknown): string {
  if (raw == null) return '';
  return csvField(typeof raw === 'string' ? raw : JSON.stringify(raw));
}

function toRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export interface ExportAccessLogInput {
  db: Database;
  returnId: string;
  firmId: string;
}

export async function exportAccessLogCsv(input: ExportAccessLogInput): Promise<string> {
  const [ret] = await input.db
    .select({ id: taxReturns.id })
    .from(taxReturns)
    .where(and(eq(taxReturns.id, input.returnId), eq(taxReturns.firmId, input.firmId)))
    .limit(1);
  if (!ret) return '';

  const rows = await input.db
    .select()
    .from(taxReturnAccessLog)
    .where(eq(taxReturnAccessLog.returnId, input.returnId))
    .orderBy(desc(taxReturnAccessLog.at));

  const lines: string[] = [];
  lines.push(
    toRow([
      'at',
      'event',
      'actor_kind',
      'actor_ref',
      'share_id',
      'page_number',
      'section_id',
      'actor_ip',
      'actor_user_agent',
      'metadata',
    ]),
  );
  for (const r of rows) {
    lines.push(
      toRow([
        r.at.toISOString(),
        r.event,
        r.actorKind,
        r.actorRef,
        r.shareId,
        r.pageNumber,
        r.sectionId,
        r.actorIp,
        r.actorUserAgent,
        r.metadata,
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

// Silence unused-import lint for sql (kept for future raw-SQL paths).
void sql;
