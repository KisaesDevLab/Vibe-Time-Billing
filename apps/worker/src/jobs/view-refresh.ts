// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Refresh the materialized views from 0003_materialized_views.sql.
// Concurrent refresh means HTTP-side reads don't block during the
// rebuild (Phase 17 acceptance criterion).

import { sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';

import type { Logger } from 'pino';

const VIEWS = ['realization_view', 'utilization_view', 'profitability_view'] as const;

export async function runViewRefresh(
  db: Database,
  log: Logger,
): Promise<{ refreshed: number; errors: number }> {
  let refreshed = 0;
  let errors = 0;
  for (const view of VIEWS) {
    try {
      // CONCURRENTLY requires a unique index — all three have one per
      // 0003_materialized_views.sql. Fallback to non-concurrent if the
      // first refresh of a new MV needs to populate.
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
      refreshed++;
      log.info({ view }, 'materialized view refreshed');
    } catch (err) {
      // Concurrent refresh fails on the first run (no rows yet); fall
      // back to a blocking refresh which always works.
      try {
        await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
        refreshed++;
        log.info({ view }, 'materialized view refreshed (non-concurrent)');
      } catch (err2) {
        errors++;
        log.error({ err: err2, view }, 'materialized view refresh failed');
      }
      void err;
    }
  }
  return { refreshed, errors };
}
