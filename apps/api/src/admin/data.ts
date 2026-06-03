// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin "Data" endpoints — destructive operations gated on
// firm:settings:write + step-up + typed confirmation.
//
//   POST /load-demo
//     Seeds the demo dataset (clients, engagements, time entries,
//     invoices, payments, file folders) into the current firm via the
//     `runDemoSeed` helper. Idempotent: prior demo rows are cleared
//     first via the `_demo_seed_id` tracker.
//
//   POST /reset
//     TRUNCATE every operational table in the vibetb schema while
//     preserving the firm row, staff identities, RBAC, taxonomy,
//     and the starter-pack templates. Body must include
//     { confirm: "delete everything" }. Equivalent to a fresh
//     bootstrap with the same firm name + admin.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { resetFirmData, runDemoSeed, type DemoSeedResult } from '@vibe/db/scripts';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface AdminDataDeps extends RbacDeps {
  db: Database | null;
  requireStepUp: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

const LoadDemoSchema = z.object({
  // Optional volume overrides for quick smoke runs from the UI.
  targets: z
    .object({
      clients: z.number().int().min(1).max(2000).optional(),
      engagements: z.number().int().min(1).max(5000).optional(),
      timeEntries: z.number().int().min(1).max(20000).optional(),
      invoices: z.number().int().min(1).max(2000).optional(),
      fileFolders: z.number().int().min(0).max(50).optional(),
      filesPerFolder: z.number().int().min(0).max(200).optional(),
    })
    .optional(),
});

const ResetSchema = z.object({
  // Typed-confirmation defense. Mirrors the install/uninstall script's
  // pattern so the muscle memory is consistent.
  confirm: z.literal('delete everything'),
});

export function createAdminDataRouter(deps: AdminDataDeps): Router {
  const router = express.Router();

  router.post(
    '/load-demo',
    requirePermission(deps, 'firm:settings:write'),
    deps.requireStepUp,
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = LoadDemoSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      let result: DemoSeedResult;
      try {
        result = await runDemoSeed(deps.db, session.firmId, {
          targets: parsed.data.targets ?? undefined,
          onLog: (msg) => logger.info({ phase: 'load-demo' }, msg),
        });
      } catch (err) {
        logger.error({ err }, 'load-demo failed');
        const message = err instanceof Error ? err.message : 'seed_failed';
        res.status(500).json({ error: 'seed_failed', message });
        return;
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'demo_seed',
        entityId: null,
        actorAppUserId: session.appUserId,
        after: result,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, ...result });
    },
  );

  router.post(
    '/reset',
    requirePermission(deps, 'firm:settings:write'),
    deps.requireStepUp,
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ResetSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'confirmation_required' });
        return;
      }

      // Record the intent BEFORE the truncate so the row survives in
      // any backup taken between the audit insert and the wipe (the
      // wipe deletes audit_log too).
      await emitAudit(deps.db, {
        action: 'RESTORE_DATABASE',
        entityType: 'firm_data',
        entityId: session.firmId,
        actorAppUserId: session.appUserId,
        after: { phase: 'reset_initiated', firmId: session.firmId },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      let wipedCount = 0;
      try {
        const result = await resetFirmData(deps.db);
        wipedCount = result.wipedTables.length;
        logger.info(
          { wiped: result.wipedTables.length, skipped: result.skippedTables.length },
          'reset complete',
        );
      } catch (err) {
        logger.error({ err }, 'reset-firm failed');
        const message = err instanceof Error ? err.message : 'reset_failed';
        res.status(500).json({ error: 'reset_failed', message });
        return;
      }
      res.json({ ok: true, tablesWiped: wipedCount });
    },
  );

  return router;
}
