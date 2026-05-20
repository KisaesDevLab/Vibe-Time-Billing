// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BullMQ worker entrypoint. Registers the recurring scheduled jobs that
// drive the appliance — recurring billing runs (Phase 10), nightly AR
// aging snapshots (Phase 15), materialized-view refresh (Phase 17), and
// dunning sweeps (Phase 15). Each job's domain logic lives in @vibe/core;
// this file is the orchestration shell.

import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { pino } from 'pino';

import { createDb, type Database } from '@vibe/db';
import type { PaymentProvider } from '@vibe/core/payments';

import { runRecurringBillingTick } from './jobs/recurring-billing';
import { runDunningSweep } from './jobs/dunning-sweep';
import { runViewRefresh } from './jobs/view-refresh';
import { runArAgingSnapshot } from './jobs/ar-aging-snapshot';

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

interface JobPayload {
  reason: string;
  scheduledFor: string;
}

const QUEUES = ['recurring-billing', 'ar-aging-snapshot', 'view-refresh', 'dunning-sweep'] as const;
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
    const result = await runRecurringBillingTick(db, logger, undefined, { chargeInvoice });
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
    const result = await runDunningSweep(db, logger);
    logger.info({ jobId: job.id, ...result }, 'dunning-sweep complete');
  },
};

const CRON: Record<QueueName, string> = {
  'recurring-billing': '*/15 * * * *',
  'ar-aging-snapshot': '30 0 * * *',
  'view-refresh': '*/15 * * * *',
  'dunning-sweep': '0 * * * *',
};

async function setup(): Promise<void> {
  for (const name of QUEUES) {
    const queue = new Queue<JobPayload>(name, { connection });
    queues.set(name, queue);

    const evt = new QueueEvents(name, { connection });
    evt.on('failed', ({ jobId, failedReason }) => {
      logger.error({ jobId, queue: name, failedReason }, 'job failed');
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
