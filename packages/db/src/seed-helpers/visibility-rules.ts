// SPDX-License-Identifier: Elastic-2.0
//
// Default firm_folder_visibility_rules pack (Phase 6 of
// FILE_MANAGER_ADDENDUM.md §3.6). Called from the firm-creation path
// and the seed script; the one-time backfill for existing firms lives
// in migration 0047.

import type { PgDatabase, QueryResultHKT } from 'drizzle-orm/pg-core';

import { firmFolderVisibilityRules } from '../schema/core';

interface SeedRule {
  pattern: string;
  visibility: 'private' | 'client_visible';
  priority: number;
  notes: string;
}

const RULES: SeedRule[] = [
  {
    pattern: 'Invoices',
    visibility: 'client_visible',
    priority: 100,
    notes: 'Default — invoices are client-facing',
  },
  {
    pattern: 'Engagement Letters',
    visibility: 'client_visible',
    priority: 100,
    notes: 'Default — letters are client-facing',
  },
  {
    pattern: 'Client Copy%',
    visibility: 'client_visible',
    priority: 100,
    notes: 'Default — anything in a Client Copy subfolder',
  },
  {
    pattern: 'Workpapers',
    visibility: 'private',
    priority: 100,
    notes: 'Default — workpapers are internal',
  },
  {
    pattern: 'Internal%',
    visibility: 'private',
    priority: 100,
    notes: 'Default — anything in an Internal subfolder',
  },
  {
    pattern: '%',
    visibility: 'private',
    priority: 0,
    notes: 'Default catchall — anything else is private',
  },
];

/**
 * Inserts the six default visibility rules for a firm. Safe to call
 * once per firm at creation; not idempotent — caller should only
 * invoke during the create-firm transaction.
 */
export async function seedFirmVisibilityRules<
  TQueryResult extends QueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: PgDatabase<TQueryResult, TFullSchema>, firmId: string): Promise<void> {
  await db.insert(firmFolderVisibilityRules).values(
    RULES.map((r) => ({
      firmId,
      subfolderPattern: r.pattern,
      defaultVisibility: r.visibility,
      priority: r.priority,
      enabled: true,
      notes: r.notes,
    })),
  );
}
