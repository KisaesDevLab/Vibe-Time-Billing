// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BullMQ worker entrypoint. Registers the recurring scheduled jobs that
// drive the appliance — recurring billing runs (Phase 10), nightly AR
// aging snapshots (Phase 15), materialized-view refresh (Phase 17), and
// dunning sweeps (Phase 15). Each job's domain logic lives in @vibe/core;
// this file is the orchestration shell.

import http from 'node:http';

import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { pino } from 'pino';

import { createDb, type Database } from '@vibe/db';
import type { PaymentProvider } from '@vibe/core/payments';

import { runRecurringBillingTick } from './jobs/recurring-billing';
import { runDunningSweep } from './jobs/dunning-sweep';
import { runViewRefresh } from './jobs/view-refresh';
import { runArAgingSnapshot } from './jobs/ar-aging-snapshot';
import { runLateFeeAccrual } from './jobs/late-fee-accrual';
import { runLateEntryAlert } from './jobs/late-entry-alert';
import { runMilestoneDateTrigger } from './jobs/milestone-date-trigger';
import { runHourBankExpiration } from './jobs/hour-bank-expiration';
import { runHourBankReplenish } from './jobs/hour-bank-replenish';
import { runApprovalEscalation } from './jobs/approval-escalation';
import { runApprovalSlaMonitor } from './jobs/approval-sla-monitor';
import { runPaymentRetry } from './jobs/payment-retry';
import { runWebhookDispatch } from './jobs/webhook-dispatch';
import { runAutoRolloverScan } from './jobs/auto-rollover';
import { runRetentionEnforcement } from './jobs/retention-enforcement';
import { runScopeCreepAlert } from './jobs/scope-creep-alert';
import { runWipAgeAlert } from './jobs/wip-age-alert';
import { runAuditAnomaly } from './jobs/audit-anomaly';
import { runSavedReportEmail } from './jobs/saved-report-email';
import { runEmailIn } from './jobs/email-in';
import { runStorageSyncTick } from './jobs/storage-sync';
import { runHashFileTick } from './jobs/hash-file';
import { buildMailDispatch, buildSmsDispatch } from './dispatchers';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'vibe-tb-worker' },
});

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const dbUrl = process.env['DATABASE_URL'];
let db: Database | null = null;
let closeDb: (() => Promise<void>) | null = null;
if (dbUrl) {
  const created = createDb({ connectionString: dbUrl });
  db = created.db;
  closeDb = created.close;
}

// Autopay: if STRIPE_SECRET_KEY is set, build a charge hook that the
// recurring-billing tick can invoke per plan. Otherwise autopay is
// skipped silently (and audit-logged in the job).
let stripe: PaymentProvider | null = null;
const stripeKey = process.env['STRIPE_SECRET_KEY'];
if (stripeKey) {
  const { createStripeProvider } = await import('@vibe/core/payments');
  stripe = createStripeProvider({ secretKey: stripeKey });
}
const chargeInvoice = stripe
  ? async (args: {
      invoiceId: string;
      paymentMethodProviderId: string;
      amountCents: number;
      metadata: Record<string, string>;
    }): Promise<{ ok: boolean; providerChargeId?: string; errorMessage?: string }> => {
      const r = await stripe!.charge({
        amountCents: args.amountCents,
        currency: 'USD',
        description: `Autopay invoice ${args.metadata['invoice_number'] ?? args.invoiceId}`,
        metadata: args.metadata,
        paymentMethod: {
          providerId: 'stripe',
          providerMethodId: args.paymentMethodProviderId,
          kind: 'CARD',
        },
      });
      return {
        ok: r.ok,
        providerChargeId: r.providerChargeId || undefined,
        errorMessage: r.errorMessage,
      };
    }
  : undefined;

const dunningSendEmail = await buildMailDispatch(logger);
const dunningSendSms = buildSmsDispatch(logger);

// Storage client (B2 in prod, MockStorageClient in dev) — used by the
// storage-sync queue handler. Built lazily so a missing optional dep
// or absent env doesn't fail the worker boot.
let storage: StorageClient | null = null;
try {
  storage = buildStorageClient(process.env);
} catch (err) {
  logger.warn({ err }, 'storage client unavailable — storage-sync will skip');
}

interface JobPayload {
  reason: string;
  scheduledFor: string;
}

const QUEUES = [
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
  'approval-sla-monitor',
  'payment-retry',
  'webhook-dispatch',
  'auto-rollover-scan',
  'retention-enforcement',
  'scope-creep-alert',
  'wip-age-alert',
  'audit-anomaly',
  'saved-report-email',
  'email-in',
  'storage-sync',
  'hash-file',
] as const;
type QueueName = (typeof QUEUES)[number];

const queues = new Map<QueueName, Queue<JobPayload>>();
const events = new Map<QueueName, QueueEvents>();
const workers = new Map<QueueName, Worker<JobPayload>>();

const handlers: Record<QueueName, (job: Job<JobPayload>) => Promise<void>> = {
  'recurring-billing': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'recurring-billing: no DB configured, skipping');
      return;
    }
    const result = await runRecurringBillingTick(db, logger, undefined, {
      chargeInvoice,
      sendEmail: dunningSendEmail,
    });
    logger.info({ jobId: job.id, ...result }, 'recurring-billing complete');
  },
  'ar-aging-snapshot': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'ar-aging snapshot: no DB configured');
      return;
    }
    const result = await runArAgingSnapshot(db, logger);
    logger.info({ jobId: job.id, ...result }, 'ar-aging snapshot complete');
  },
  'view-refresh': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'view-refresh: no DB configured');
      return;
    }
    const result = await runViewRefresh(db, logger);
    logger.info({ jobId: job.id, ...result }, 'view-refresh complete');
  },
  'dunning-sweep': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'dunning-sweep: no DB configured');
      return;
    }
    const result = await runDunningSweep(db, logger, undefined, {
      sendEmail: dunningSendEmail,
      sendSms: dunningSendSms,
      portalBaseUrl: process.env['PORTAL_BASE_URL'],
    });
    logger.info({ jobId: job.id, ...result }, 'dunning-sweep complete');
  },
  'late-fee-accrual': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'late-fee-accrual: no DB configured');
      return;
    }
    const flatCents = parseInt(process.env['LATE_FEE_FLAT_CENTS'] ?? '0', 10);
    const pctMonthly = parseFloat(process.env['LATE_FEE_PCT_MONTHLY'] ?? '0');
    const result = await runLateFeeAccrual(db, logger, undefined, {
      flatCents: Number.isFinite(flatCents) ? flatCents : 0,
      pctMonthly: Number.isFinite(pctMonthly) ? pctMonthly : 0,
    });
    logger.info({ jobId: job.id, ...result }, 'late-fee-accrual complete');
  },
  'late-entry-alert': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'late-entry-alert: no DB configured');
      return;
    }
    const result = await runLateEntryAlert(db, logger, undefined, {
      sendEmail: dunningSendEmail,
    });
    logger.info({ jobId: job.id, ...result }, 'late-entry-alert complete');
  },
  'milestone-date-trigger': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'milestone-date-trigger: no DB configured');
      return;
    }
    const result = await runMilestoneDateTrigger(db, logger);
    logger.info({ jobId: job.id, ...result }, 'milestone-date-trigger complete');
  },
  'hour-bank-expiration': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'hour-bank-expiration: no DB configured');
      return;
    }
    const result = await runHourBankExpiration(db, logger);
    logger.info({ jobId: job.id, ...result }, 'hour-bank-expiration complete');
  },
  'hour-bank-replenish': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'hour-bank-replenish: no DB configured');
      return;
    }
    const result = await runHourBankReplenish(db, logger);
    logger.info({ jobId: job.id, ...result }, 'hour-bank-replenish complete');
  },
  'approval-escalation': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'approval-escalation: no DB configured');
      return;
    }
    const result = await runApprovalEscalation(db, logger);
    logger.info({ jobId: job.id, ...result }, 'approval-escalation complete');
  },
  'approval-sla-monitor': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'approval-sla-monitor: no DB configured');
      return;
    }
    const result = await runApprovalSlaMonitor(db, logger);
    logger.info({ jobId: job.id, ...result }, 'approval-sla-monitor complete');
  },
  'payment-retry': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'payment-retry: no DB configured');
      return;
    }
    const result = await runPaymentRetry(db, logger, { chargeInvoice });
    logger.info({ jobId: job.id, ...result }, 'payment-retry complete');
  },
  'webhook-dispatch': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'webhook-dispatch: no DB configured');
      return;
    }
    const result = await runWebhookDispatch(db, logger);
    logger.info({ jobId: job.id, ...result }, 'webhook-dispatch complete');
  },
  'auto-rollover-scan': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'auto-rollover-scan: no DB configured');
      return;
    }
    const result = await runAutoRolloverScan(db, logger);
    logger.info({ jobId: job.id, ...result }, 'auto-rollover-scan complete');
  },
  'retention-enforcement': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'retention-enforcement: no DB configured');
      return;
    }
    const result = await runRetentionEnforcement(db, logger);
    logger.info({ jobId: job.id, ...result }, 'retention-enforcement complete');
  },
  'scope-creep-alert': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'scope-creep-alert: no DB configured');
      return;
    }
    const result = await runScopeCreepAlert(db, logger);
    logger.info({ jobId: job.id, ...result }, 'scope-creep-alert complete');
  },
  'wip-age-alert': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'wip-age-alert: no DB configured');
      return;
    }
    const result = await runWipAgeAlert(db, logger);
    logger.info({ jobId: job.id, ...result }, 'wip-age-alert complete');
  },
  'audit-anomaly': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'audit-anomaly: no DB configured');
      return;
    }
    const result = await runAuditAnomaly(db, logger);
    logger.info({ jobId: job.id, ...result }, 'audit-anomaly complete');
  },
  'saved-report-email': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'saved-report-email: no DB configured');
      return;
    }
    const result = await runSavedReportEmail(db, logger, dunningSendEmail);
    logger.info({ jobId: job.id, ...result }, 'saved-report-email complete');
  },
  'email-in': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'email-in: no DB configured');
      return;
    }
    const result = await runEmailIn(db, logger);
    logger.info({ jobId: job.id, ...result }, 'email-in complete');
  },
  'storage-sync': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'storage-sync: no DB configured');
      return;
    }
    if (!storage) {
      logger.warn({ jobId: job.id }, 'storage-sync: no storage client configured');
      return;
    }
    const result = await runStorageSyncTick(db, storage, logger);
    logger.info({ jobId: job.id, ...result }, 'storage-sync complete');
  },
  'hash-file': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'hash-file: no DB configured');
      return;
    }
    if (!storage) {
      logger.warn({ jobId: job.id }, 'hash-file: no storage client configured');
      return;
    }
    const result = await runHashFileTick(db, storage, logger);
    logger.info({ jobId: job.id, ...result }, 'hash-file complete');
  },
};

const CRON: Record<QueueName, string> = {
  'recurring-billing': '*/15 * * * *',
  'ar-aging-snapshot': '30 0 * * *',
  'view-refresh': '*/15 * * * *',
  'dunning-sweep': '0 * * * *',
  'late-fee-accrual': '15 1 * * *',
  'late-entry-alert': '0 9 * * 1-5',
  'milestone-date-trigger': '5 1 * * *',
  'hour-bank-expiration': '10 1 * * *',
  'hour-bank-replenish': '40 1 * * *',
  'approval-escalation': '20 * * * *',
  'approval-sla-monitor': '50 * * * *',
  'payment-retry': '15 2 * * *',
  'webhook-dispatch': '*/2 * * * *',
  'auto-rollover-scan': '30 2 * * *',
  'retention-enforcement': '45 3 * * *',
  'scope-creep-alert': '50 7 * * 1',
  'wip-age-alert': '30 8 * * 1',
  'audit-anomaly': '*/15 * * * *',
  'saved-report-email': '0 7 * * 1',
  'email-in': '*/5 * * * *',
  // Phase 3 of FILE_MANAGER_ADDENDUM.md — sync cadence honors
  // SYNC_INTERVAL_SECONDS via cron rounding (default 120s → */2 min).
  'storage-sync': storageSyncCron(),
  // Phase 5 of FILE_MANAGER_ADDENDUM.md — SHA-256 hashing. Runs less
  // often than the sync tick (every 5 min) because it streams bodies
  // and is bounded by HASH_BATCH_SIZE per tick.
  'hash-file': '*/5 * * * *',
};

function storageSyncCron(): string {
  const seconds = parseInt(process.env['SYNC_INTERVAL_SECONDS'] ?? '120', 10);
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 120;
  const minutes = Math.max(1, Math.round(safe / 60));
  return `*/${minutes} * * * *`;
}

async function setup(): Promise<void> {
  for (const name of QUEUES) {
    const queue = new Queue<JobPayload>(name, { connection });
    queues.set(name, queue);

    const evt = new QueueEvents(name, { connection });
    // Phase 10 #34 — alerting on job failures. Audit-log every BullMQ
    // 'failed' event so the staff Alerts inbox surfaces it alongside
    // wip-age, scope-creep, and audit-anomaly notifications. Suppress
    // is per-(queue, jobId) duplicate within the same hour so retried
    // failures don't spam.
    evt.on('failed', ({ jobId, failedReason }) => {
      logger.error({ jobId, queue: name, failedReason }, 'job failed');
      if (!db) return;
      const cutoff = new Date(Date.now() - 60 * 60_000);
      void (async () => {
        try {
          // QA fix — auditLog.entityId is uuid. BullMQ jobIds look like
          // "repeat:webhook-dispatch:scheduler:1779403047000" which threw
          // 22P02 both on the dedup SELECT and the INSERT. Stash the real
          // jobId in afterJson and dedup against that via the JSONB key.
          const { sql, and, eq, gte } = await import('drizzle-orm');
          const { auditLog } = await import('@vibe/db/schema');
          const [dup] = await db!
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.entityType, 'worker_job_failure'),
                sql`${auditLog.afterJson} ->> 'jobId' = ${jobId}`,
                gte(auditLog.occurredAt, cutoff),
              ),
            )
            .limit(1);
          if (dup) return;
          await db!.insert(auditLog).values({
            action: 'CREATE',
            entityType: 'worker_job_failure',
            entityId: null,
            actorMcpTokenId: 'worker',
            afterJson: { queue: name, jobId, failedReason },
          });
        } catch (err) {
          logger.error({ err, queue: name, jobId }, 'job-failure audit emit failed');
        }
      })();
    });
    events.set(name, evt);

    const w = new Worker<JobPayload>(name, async (job) => handlers[name](job), {
      connection,
      concurrency: 1,
    });
    workers.set(name, w);

    await queue.upsertJobScheduler(
      `${name}:scheduler`,
      { pattern: CRON[name] },
      {
        name: `${name}:tick`,
        data: { reason: 'scheduled', scheduledFor: new Date().toISOString() },
      },
    );
  }
  logger.info({ queues: QUEUES, dbConfigured: Boolean(db) }, 'vibe-tb-worker started');
  startHealthServer();
}

// Phase 25 #11 — per-service health probe. Tiny HTTP listener that
// exposes /health for k8s/docker healthchecks against the worker
// process specifically (distinct from the api's /health). Default
// port 3003; override via WORKER_HEALTH_PORT.
function startHealthServer(): void {
  const port = parseInt(process.env['WORKER_HEALTH_PORT'] ?? '3003', 10) || 3003;
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const queueNames = Array.from(workers.keys());
      const queuesUp = workers.size > 0;
      const dbUp = Boolean(db);
      res.writeHead(queuesUp ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          service: 'vibe-tb-worker',
          ok: queuesUp,
          db: dbUp,
          queueCount: workers.size,
          queues: queueNames,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        }),
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  // QA fix — see api/src/server.ts: tsx watch hot-restart races the
  // dying listener; retry on EADDRINUSE indefinitely in dev (capped in
  // prod) so the worker survives fast reloads.
  const isProd = process.env['NODE_ENV'] === 'production';
  const maxAttempts = isProd ? 16 : Number.POSITIVE_INFINITY;
  let attempt = 0;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
      attempt += 1;
      const delayMs = Math.min(250 * Math.pow(1.5, attempt - 1), 3000);
      logger.warn({ port, attempt, delayMs }, 'worker health port busy, retrying');
      setTimeout(() => server.listen(port), delayMs);
      return;
    }
    logger.fatal({ err }, 'worker health server failed to bind — exiting');
    process.exit(1);
  });
  server.listen(port, () => logger.info({ port, attempt }, 'worker health server listening'));

  function shutdownHealth(signal: string): void {
    logger.info({ signal }, 'received shutdown signal — closing worker health server');
    server.close(() => undefined);
    setTimeout(() => undefined, 100).unref();
  }
  process.on('SIGTERM', () => shutdownHealth('SIGTERM'));
  process.on('SIGINT', () => shutdownHealth('SIGINT'));
}

async function shutdown(): Promise<void> {
  for (const w of workers.values()) await w.close();
  for (const q of queues.values()) await q.close();
  for (const e of events.values()) await e.close();
  await connection.quit();
  if (closeDb) await closeDb();
}

setup().catch((err: unknown) => {
  logger.error({ err }, 'worker boot fatal');
  process.exit(1);
});

process.on('SIGINT', () => {
  shutdown()
    .catch((err: unknown) => logger.error({ err }, 'shutdown error'))
    .finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  shutdown()
    .catch((err: unknown) => logger.error({ err }, 'shutdown error'))
    .finally(() => process.exit(0));
});
