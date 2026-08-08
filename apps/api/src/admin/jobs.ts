// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin endpoints to manually trigger background-worker jobs. The worker
// runs them on cron; this surface lets an operator force a run right
// now (after restoring data, during a demo, or to verify wiring).

import express, { type Request, type Response, type Router } from 'express';
import IORedis from 'ioredis';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { jobRun, jobSchedule } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import { previewJob } from './job-preview';

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
  | 'hour-bank-replenish'
  | 'approval-escalation'
  | 'webhook-dispatch'
  | 'auto-rollover-scan'
  | 'retention-enforcement'
  | 'scope-creep-alert'
  | 'wip-age-alert'
  | 'audit-anomaly'
  | 'saved-report-email'
  | 'payment-plan-charge'
  | 'email-in'
  | 'ai-cost-sync';

const JOB_NAMES: readonly JobName[] = [
  'recurring-billing',
  'ar-aging-snapshot',
  'view-refresh',
  'dunning-sweep',
  'late-fee-accrual',
  'late-entry-alert',
  'milestone-date-trigger',
  'hour-bank-expiration',
  'hour-bank-replenish',
  'approval-escalation',
  'webhook-dispatch',
  'auto-rollover-scan',
  'retention-enforcement',
  'scope-creep-alert',
  'wip-age-alert',
  'audit-anomaly',
  'saved-report-email',
  'payment-plan-charge',
  'email-in',
  'ai-cost-sync',
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

  // Enabled state per job (default true when no row exists yet).
  router.get(
    '/schedules',
    requirePermission(deps, 'admin:backup:manage'),
    async (_req: Request, res: Response) => {
      const enabled: Record<string, boolean> = {};
      for (const n of JOB_NAMES) enabled[n] = true;
      if (deps.db) {
        const rows = await deps.db
          .select({ jobName: jobSchedule.jobName, enabled: jobSchedule.enabled })
          .from(jobSchedule);
        for (const r of rows) if (r.jobName in enabled) enabled[r.jobName] = r.enabled;
      }
      res.json({ schedules: enabled });
    },
  );

  // Enable / disable a job (upsert).
  router.patch(
    '/:name',
    requirePermission(deps, 'admin:backup:manage'),
    async (req: Request, res: Response) => {
      const name = req.params['name'] as JobName;
      if (!JOB_NAMES.includes(name)) {
        res.status(400).json({ error: 'unknown_job' });
        return;
      }
      const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .insert(jobSchedule)
        .values({ jobName: name, enabled: parsed.data.enabled })
        .onConflictDoUpdate({
          target: jobSchedule.jobName,
          set: { enabled: parsed.data.enabled, updatedAt: new Date() },
        });
      res.json({ ok: true, name, enabled: parsed.data.enabled });
    },
  );

  // Recent run history for a job.
  router.get(
    '/:name/runs',
    requirePermission(deps, 'admin:backup:manage'),
    async (req: Request, res: Response) => {
      const name = req.params['name'] as JobName;
      if (!JOB_NAMES.includes(name)) {
        res.status(400).json({ error: 'unknown_job' });
        return;
      }
      if (!deps.db) {
        res.json({ runs: [] });
        return;
      }
      const runs = await deps.db
        .select()
        .from(jobRun)
        .where(eq(jobRun.jobName, name))
        .orderBy(desc(jobRun.startedAt))
        .limit(25);
      res.json({ runs });
    },
  );

  // Dry-run preview — read-only count of what the job would act on now.
  router.post(
    '/:name/preview',
    requirePermission(deps, 'admin:backup:manage'),
    async (req: Request, res: Response) => {
      const name = req.params['name'] as JobName;
      if (!JOB_NAMES.includes(name)) {
        res.status(400).json({ error: 'unknown_job' });
        return;
      }
      if (!deps.db) {
        res.json({ supported: false, note: 'db unavailable' });
        return;
      }
      const preview = await previewJob(deps.db, name);
      res.json(preview);
    },
  );

  return router;
}
