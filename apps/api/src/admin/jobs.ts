// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin endpoints to manually trigger background-worker jobs. The worker
// runs them on cron; this surface lets an operator force a run right
// now (after restoring data, during a demo, or to verify wiring).

import express, { type Request, type Response, type Router } from 'express';
import IORedis from 'ioredis';

import type { Database } from '@vibe/db';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface AdminJobRoutesDeps extends RbacDeps {
  db: Database | null;
  redisUrl: string;
}

type JobName =
  | 'recurring-billing'
  | 'ar-aging-snapshot'
  | 'view-refresh'
  | 'dunning-sweep'
  | 'late-fee-accrual'
  | 'late-entry-alert'
  | 'milestone-date-trigger'
  | 'hour-bank-expiration'
  | 'approval-escalation'
  | 'webhook-dispatch'
  | 'auto-rollover-scan'
  | 'retention-enforcement'
  | 'scope-creep-alert'
  | 'wip-age-alert'
  | 'audit-anomaly'
  | 'saved-report-email'
  | 'email-in';

const JOB_NAMES: readonly JobName[] = [
  'recurring-billing',
  'ar-aging-snapshot',
  'view-refresh',
  'dunning-sweep',
  'late-fee-accrual',
  'late-entry-alert',
  'milestone-date-trigger',
  'hour-bank-expiration',
  'approval-escalation',
  'webhook-dispatch',
  'auto-rollover-scan',
  'retention-enforcement',
  'scope-creep-alert',
  'wip-age-alert',
  'audit-anomaly',
  'saved-report-email',
  'email-in',
];

export function createAdminJobRouter(deps: AdminJobRoutesDeps): Router {
  const router = express.Router();

  router.post(
    '/run/:name',
    requirePermission(deps, 'admin:backup:manage'),
    async (req: Request, res: Response) => {
      const name = req.params['name'] as JobName;
      if (!JOB_NAMES.includes(name)) {
        res.status(400).json({ error: 'unknown_job' });
        return;
      }
      // BullMQ uses a separate connection on each enqueue — keep this
      // out of the long-lived API redis client.
      const connection = new IORedis(deps.redisUrl, { maxRetriesPerRequest: null });
      try {
        const { Queue } = await import('bullmq');
        const q = new Queue(name, { connection });
        await q.add(`${name}:manual`, {
          reason: 'manual_admin_trigger',
          scheduledFor: new Date().toISOString(),
        });
        await q.close();
        logger.info({ job: name }, 'manual job enqueue ok');
        res.json({ ok: true, enqueued: name });
      } catch (err) {
        logger.error({ err, job: name }, 'manual job enqueue failed');
        res.status(502).json({ error: 'enqueue_failed' });
      } finally {
        await connection.quit().catch(() => undefined);
      }
    },
  );

  router.get(
    '/stats',
    requirePermission(deps, 'admin:backup:manage'),
    async (_req: Request, res: Response) => {
      const connection = new IORedis(deps.redisUrl, { maxRetriesPerRequest: null });
      try {
        const { Queue } = await import('bullmq');
        const stats: Record<
          string,
          { waiting: number; active: number; delayed: number; failed: number }
        > = {};
        for (const name of JOB_NAMES) {
          const q = new Queue(name, { connection });
          const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
          stats[name] = {
            waiting: counts['waiting'] ?? 0,
            active: counts['active'] ?? 0,
            delayed: counts['delayed'] ?? 0,
            failed: counts['failed'] ?? 0,
          };
          await q.close();
        }
        res.json({ stats });
      } catch (err) {
        logger.error({ err }, 'job stats fetch failed');
        res.status(502).json({ error: 'fetch_failed' });
      } finally {
        await connection.quit().catch(() => undefined);
      }
    },
  );

  router.get(
    '/known',
    requirePermission(deps, 'admin:backup:manage'),
    async (_req: Request, res: Response) => {
      res.json({ jobs: JOB_NAMES });
    },
  );

  return router;
}
