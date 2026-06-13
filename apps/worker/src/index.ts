// SPDX-License-Identifier: Elastic-2.0
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
import { runRequestSuggestionSweep } from './jobs/request-suggestion-sweep';
import { runRetainerExpirySweep } from './jobs/retainer-expiry-sweep';
import { runRecurringEngagementTick } from './jobs/recurring-engagement';
import { runRequestReminderTick } from './jobs/request-reminder';
import { runCloudflareTunnelStatusTick } from './jobs/cloudflare-tunnel-status';
import { runOpenSignPollTick } from './jobs/opensign-poll';
import { runSignaturesPollTick } from './jobs/signatures-poll';
import { runCalendarSyncTick } from '../../api/src/calendar/sync-tick';
import { runCalendarMatch } from '../../api/src/calendar/match';
import { runCalendarReminderTick } from '../../api/src/calendar/reminder-tick';
import { runCalendarSuggestionTick } from '../../api/src/calendar/suggestion-tick';
import {
  runAppointmentProviderWrite,
  runAppointmentProviderUpdate,
  runAppointmentProviderDelete,
  type ProviderJobDeps,
  type ProviderJobResult,
} from '../../api/src/appointments/provider-jobs';
import {
  APPOINTMENT_PROVIDER_WRITE_QUEUE,
  APPOINTMENT_PROVIDER_UPDATE_QUEUE,
  APPOINTMENT_PROVIDER_DELETE_QUEUE,
  APPOINTMENT_CONFIRMATION_QUEUE,
  APPOINTMENT_RESCHEDULE_CONFIRMATION_QUEUE,
  APPOINTMENT_CANCELLATION_QUEUE,
  APPOINTMENT_DECLINE_QUEUE,
  APPOINTMENT_RESCHEDULE_REQUESTED_STAFF_QUEUE,
  type ProviderJob,
  type AppointmentJob,
  type CancellationJob,
  type RescheduleRequestedStaffJob,
} from '../../api/src/appointments/queue';
import {
  runAppointmentConfirmationSend,
  runAppointmentRescheduleConfirmationSend,
  runAppointmentCancellationSend,
  runAppointmentDeclineSend,
  runAppointmentRescheduleRequestedStaffSend,
  runAppointmentReminderTick,
  type SendAppointmentEmail,
} from '../../api/src/appointments/email-jobs';
import { runRetainerOfferExpirySweep } from './jobs/retainer-offer-expiry-sweep';
import {
  runRetainerOfferReminder,
  type OfferReminderJobPayload,
} from './jobs/retainer-offer-reminder';
import {
  runRetainerExpiryWarning,
  type ExpiryWarningJobPayload,
} from './jobs/retainer-expiry-warning';
import {
  runStagedNotificationSend,
  type StagedNotificationSendPayload,
} from './jobs/staged-notification-send';
import { runShieldHealthcheck } from './jobs/shield-healthcheck';
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
import { runPendingUploadSweep } from './jobs/pending-upload-sweep';
import { runFolderRename, type FolderRenamePayload } from './jobs/folder-rename';
import { runIntakeProcess } from './jobs/intake-process';
import { runFilerRoute, type FilerRouteJob } from './jobs/filer-route';
import { runZipImport, type ZipImportJob } from './jobs/zip-import';
import { runInternalMessageNotify } from './jobs/internal-message-notify';
import { incCounter, observeDurationSeconds, renderPrometheusText } from './metrics';
import { buildMailDispatch, buildSmsDispatch, buildVoiceDispatch } from './dispatchers';
import { loadFirmSmsProvider } from '../../api/src/messaging/sms-resolver';
import type { SmsProvider } from '../../api/src/sms/provider';
import { buildStorageClient, type StorageClient } from '@vibe/storage';
// Cross-app reuse (same pattern as the sms-resolver import above): the
// worker hydrates the operator's UI-configured storage provider from the
// DB exactly like the api does at boot. Without this the worker would
// fall back to the env-var default (mock in local), so storage-sync
// would never see the real B2 bucket and would mark every folder
// `missing`. bootCrypto unseals the firm key (shared sealed-on-disk
// seal file); applyStorageSettingsFromDb decrypts the creds into
// process.env so the buildStorageClient(process.env) call below resolves
// to the same B2/MinIO provider the api uses.
import { bootCrypto } from '../../api/src/crypto/boot';
import { applyStorageSettingsFromDb } from '../../api/src/admin/storage-settings/boot';

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
const voiceDispatch = buildVoiceDispatch(logger);

// Hydrate UI-configured storage credentials from the DB before building
// the storage client. Mirrors the api boot sequence (server.ts): unseal
// the firm key, then fold the operator's storage_settings row into
// process.env. Non-fatal — every failure mode (no firm, locked, no seal
// file) leaves the env-var fallback intact, so the worker still boots.
// Requires the shared firm-key seal file (FIRM_KEY_SEAL_PATH + the
// firm-key volume must match the api's, see docker-compose).
try {
  await bootCrypto(db);
  await applyStorageSettingsFromDb(db);
} catch (err) {
  logger.warn({ err }, 'storage settings hydrate from DB failed — using env storage config');
}

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
  'pending-upload-sweep',
  'request-suggestion-sweep',
  'shield-healthcheck',
  'retainer-expiry-sweep',
  'retainer-offer-expiry-sweep',
  // 0083 — recurring engagements. Daily sweep at 02:45 spawns the
  // next engagement per active recurrence (or queues a Q23 approval
  // on collision).
  'recurring-engagement',
  // 0084 — request reminders. Daily 03:00 sweep emails the client
  // billing contact when an OPEN/NEEDS_INFO request is within
  // reminder_days_before of its due date.
  'request-reminder',
  'cloudflare-tunnel-status',
  // Q35 — OpenSign completion poll (safety net for the webhook).
  'opensign-poll',
  // 0108 — Signatures module completion poll + expiry sweep.
  'signatures-poll',
  // 0109 — Calendar poll sync heartbeat (per-firm interval gated in-job).
  'calendar-sync',
  // 0111 — Calendar appointment reminders.
  'calendar-reminders',
  // 0112 — post-appointment time-entry suggestions.
  'calendar-time-suggestion',
  // BK gap fix — pre-meeting reminders for booked appointments (D-BK-06).
  'appointment-reminders',
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
  'pending-upload-sweep': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'pending-upload-sweep: no DB configured');
      return;
    }
    if (!storage) {
      logger.warn({ jobId: job.id }, 'pending-upload-sweep: no storage client configured');
      return;
    }
    const result = await runPendingUploadSweep(db, storage, logger);
    logger.info({ jobId: job.id, ...result }, 'pending-upload-sweep complete');
  },
  'request-suggestion-sweep': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'request-suggestion-sweep: no DB configured');
      return;
    }
    const result = await runRequestSuggestionSweep(db, logger);
    logger.info({ jobId: job.id, ...result }, 'request-suggestion-sweep complete');
  },
  'shield-healthcheck': async (job) => {
    const result = await runShieldHealthcheck({ db, redis: connection, log: logger });
    logger.info({ jobId: job.id, ...result }, 'shield-healthcheck complete');
  },
  'retainer-expiry-sweep': instrumentRetainerJob('retainer-expiry-sweep', async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'retainer-expiry-sweep: no DB configured');
      return;
    }
    const result = await runRetainerExpirySweep(db, logger);
    // R6-followup — sweep heartbeat for /health/retainers.
    await connection
      .set('retainer:sweep:expiry:last_run', new Date().toISOString())
      .catch((err) => logger.warn({ err }, 'retainer expiry sweep heartbeat failed'));
    logger.info({ jobId: job.id, ...result }, 'retainer-expiry-sweep complete');
  }),
  'retainer-offer-expiry-sweep': instrumentRetainerJob(
    'retainer-offer-expiry-sweep',
    async (job) => {
      if (!db) {
        logger.warn({ jobId: job.id }, 'retainer-offer-expiry-sweep: no DB configured');
        return;
      }
      const result = await runRetainerOfferExpirySweep(db, logger);
      await connection
        .set('retainer:sweep:offer:last_run', new Date().toISOString())
        .catch((err) => logger.warn({ err }, 'retainer offer sweep heartbeat failed'));
      logger.info({ jobId: job.id, ...result }, 'retainer-offer-expiry-sweep complete');
    },
  ),
  'recurring-engagement': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'recurring-engagement: no DB configured');
      return;
    }
    const result = await runRecurringEngagementTick(db, logger);
    logger.info({ jobId: job.id, ...result }, 'recurring-engagement complete');
  },
  'request-reminder': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'request-reminder: no DB configured');
      return;
    }
    const result = await runRequestReminderTick(db, logger, {
      sendEmail: dunningSendEmail,
      sendSms: dunningSendSms,
      portalBaseUrl: process.env['PORTAL_BASE_URL'],
    });
    logger.info({ jobId: job.id, ...result }, 'request-reminder complete');
  },
  'cloudflare-tunnel-status': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'cloudflare-tunnel-status: no DB configured');
      return;
    }
    const result = await runCloudflareTunnelStatusTick(db, logger, {});
    logger.info({ jobId: job.id, ...result }, 'cloudflare-tunnel-status complete');
  },
  'opensign-poll': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'opensign-poll: no DB configured');
      return;
    }
    const result = await runOpenSignPollTick(db, logger, { storage });
    logger.info({ jobId: job.id, ...result }, 'opensign-poll complete');
  },
  'signatures-poll': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'signatures-poll: no DB configured');
      return;
    }
    const result = await runSignaturesPollTick(db, logger, {
      storage,
      sendEmail: dunningSendEmail,
    });
    logger.info({ jobId: job.id, ...result }, 'signatures-poll complete');
  },
  'calendar-sync': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'calendar-sync: no DB configured');
      return;
    }
    const result = await runCalendarSyncTick(db, logger, {
      // CAL-4 — match each newly-ingested event right after sync.
      onNewEvents: async (eventIds) => {
        for (const id of eventIds) {
          await runCalendarMatch(db, id).catch((err) =>
            logger.warn({ err, eventId: id }, 'calendar match failed'),
          );
        }
      },
    });
    logger.info({ jobId: job.id, ...result }, 'calendar-sync complete');
  },
  'calendar-reminders': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'calendar-reminders: no DB configured');
      return;
    }
    const result = await runCalendarReminderTick(db, logger, {
      sendEmail: dunningSendEmail
        ? (a) => dunningSendEmail!({ to: a.to, subject: a.subject, body: a.body })
        : undefined,
      rsvpBaseUrl:
        process.env['CALENDAR_RSVP_BASE_URL'] ??
        process.env['PORTAL_BASE_URL'] ??
        process.env['APP_BASE_URL'] ??
        '',
    });
    logger.info({ jobId: job.id, ...result }, 'calendar-reminders complete');
  },
  'calendar-time-suggestion': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'calendar-time-suggestion: no DB configured');
      return;
    }
    const result = await runCalendarSuggestionTick(db);
    logger.info({ jobId: job.id, ...result }, 'calendar-time-suggestion complete');
  },
  'appointment-reminders': async (job) => {
    if (!db) {
      logger.warn({ jobId: job.id }, 'appointment-reminders: no DB configured');
      return;
    }
    const liveDb = db;
    const sendEmail: SendAppointmentEmail = async (mail) => {
      if (!dunningSendEmail) return;
      await dunningSendEmail({
        to: mail.to,
        subject: mail.subject,
        body: mail.body,
        ics: mail.ics,
      });
    };
    // 0121 — SMS resolves the firm's DB-backed provider (Admin → Messaging)
    // first, falling back to the env dispatcher. Providers cached per firm.
    const smsByFirm = new Map<string, SmsProvider | null>();
    const sendSms = async (m: { to: string; body: string; firmId: string }): Promise<void> => {
      let provider = smsByFirm.get(m.firmId);
      if (provider === undefined) {
        provider = await loadFirmSmsProvider(liveDb, m.firmId, logger);
        smsByFirm.set(m.firmId, provider);
      }
      if (provider) {
        const r = await provider.send({ to: m.to, body: m.body });
        if (!r.ok) throw new Error(r.error ?? 'sms_failed');
        return;
      }
      if (dunningSendSms) await dunningSendSms({ to: m.to, body: m.body });
    };
    const result = await runAppointmentReminderTick({
      db,
      sendEmail,
      sendSms,
      // Voice is env-configured (no admin UI yet); undefined → tick skips CALL.
      placeCall: voiceDispatch ? (m) => voiceDispatch(m) : undefined,
      appBaseUrl: process.env['APP_BASE_URL'],
    });
    logger.info({ jobId: job.id, ...result }, 'appointment-reminders complete');
  },
};

// Phase 13 — retainer addendum observability. Wraps a job handler so
// the worker emits retainer_job_duration_seconds (histogram) +
// retainer_job_total{outcome} + retainer_job_failures_total counters
// to the worker's /metrics endpoint without scattering try/finally.
function instrumentRetainerJob<T extends Job>(
  jobName: string,
  fn: (job: T) => Promise<void>,
): (job: T) => Promise<void> {
  return async (job) => {
    const startedAt = Date.now();
    try {
      await fn(job);
      observeDurationSeconds('retainer_job_duration_seconds', (Date.now() - startedAt) / 1000, {
        job: jobName,
      });
      incCounter('retainer_job_total', { job: jobName, outcome: 'success' });
    } catch (err) {
      observeDurationSeconds('retainer_job_duration_seconds', (Date.now() - startedAt) / 1000, {
        job: jobName,
      });
      incCounter('retainer_job_total', { job: jobName, outcome: 'failure' });
      incCounter('retainer_job_failures_total', { job: jobName });
      throw err;
    }
  };
}

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
  // Phase 8 of FILE_MANAGER_ADDENDUM.md — pending-upload reservation
  // sweep. Runs every 5 min; deletes any pending_upload row older than
  // PENDING_UPLOAD_MAX_AGE_MIN (default 30) whose body never landed.
  'pending-upload-sweep': '*/5 * * * *',
  // Stage 3 — expire stale client-request time-entry suggestions
  // hourly. The window is firm-configurable (firm_config.
  // suggestion_expiration_days; default 7) but the sweep cadence is
  // global.
  'request-suggestion-sweep': '30 * * * *',
  // P5.2 — Vibe Shield reachability probe every 5 min. Result lives in
  // Redis with a 10-min TTL; two consecutive misses flip cloud egress
  // off.
  'shield-healthcheck': '*/5 * * * *',
  // R4 — Retainer addendum. Daily 02:00/02:15 sweeps flip expired
  // retainers + offers to status='expired'. Per D4, unused hours
  // forfeit on expiry (no refund / no rollover).
  'retainer-expiry-sweep': '0 2 * * *',
  'retainer-offer-expiry-sweep': '15 2 * * *',
  // 0083 — recurring engagements. Daily 02:45 sweep fires SCHEDULE
  // recurrences whose next_run_date <= today and ON_COMPLETION
  // recurrences whose previous engagement just closed.
  'recurring-engagement': '45 2 * * *',
  // 0084 — request reminders. Daily 03:00 — emails the client billing
  // contact when an OPEN/NEEDS_INFO request is within
  // reminder_days_before of its due_date.
  'request-reminder': '0 3 * * *',
  'cloudflare-tunnel-status': '* * * * *',
  // Q35 — poll OpenSign envelopes every 2 min as a safety net for any
  // webhook delivery that never landed. Skips cleanly if OPENSIGN_URL
  // is unset.
  'opensign-poll': '*/2 * * * *',
  // 0108 — reconcile signature_requests + sweep expiries every 2 min.
  'signatures-poll': '*/2 * * * *',
  // 0109 — calendar poll heartbeat every 5 min (per-firm interval gated
  // in-job, so the effective interval is max(5, configured)).
  'calendar-sync': '*/5 * * * *',
  // 0111 — appointment reminder scheduler every 5 min.
  'calendar-reminders': '*/5 * * * *',
  // 0112 — post-appointment time suggestions every 5 min.
  'calendar-time-suggestion': '*/5 * * * *',
  // Appointment reminders every 5 min (offsets gated in-job).
  'appointment-reminders': '*/5 * * * *',
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

  // Phase 9 of FILE_MANAGER_ADDENDUM.md — parameterized storage-mutation
  // queue. Distinct from the cron-tick queues above: jobs are enqueued
  // on demand by the API with rich payloads, never on a schedule. Holds
  // a dedicated IORedis publisher for storage-progress:{id} channel.
  setupStorageMutationQueue();

  // R4-followup — delayed-only retainer notification queues. The API
  // enqueues jobs with deterministic jobIds at offer-creation /
  // activation time; handlers fire after the queue delay elapses.
  setupRetainerDelayedQueues();

  // 0146 — staged client-notification sends (delayed-only; enqueued by
  // the API at decision time).
  setupStagedNotificationQueue();

  // Document-intake pipeline. Enqueued on demand by the API at
  // /session/:id/complete (never on a schedule); scans + assembles +
  // notifies. Same parallel-registration pattern as storage-mutation.
  setupIntakeProcessQueue();

  // Vibe Filer route/undo pipeline. Enqueued on demand by the API at
  // /filer/commit and /filer/.../undo; relocates inbox objects into client
  // folders (copy → log → delete) and reverses it on undo.
  setupFilerRouteQueue();
  setupZipImportQueue();

  // Staff-to-staff message notifications (debounced email/SMS fan-out).
  setupInternalMessageNotifyQueue();

  // BK-5 — per-staff appointment calendar write-back (enqueued on demand
  // by the booking API; no schedule).
  setupAppointmentProviderQueues();

  // BK-6 — appointment confirmation / reschedule / cancellation emails.
  setupAppointmentEmailQueues();

  logger.info({ queues: QUEUES, dbConfigured: Boolean(db) }, 'vibe-tb-worker started');
  startHealthServer();
}

const INTAKE_PROCESS_QUEUE = 'intake-process';
interface IntakeJobPayload {
  sessionId: string;
  firmId: string;
}

function setupIntakeProcessQueue(): void {
  if (!db || !storage) {
    logger.warn(
      { dbConfigured: Boolean(db), storageConfigured: Boolean(storage) },
      'intake-process queue not registered — db or storage missing',
    );
    return;
  }
  const intakeQueue = new Queue<IntakeJobPayload>(INTAKE_PROCESS_QUEUE, { connection });
  const intakeEvents = new QueueEvents(INTAKE_PROCESS_QUEUE, { connection });
  intakeEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, queue: INTAKE_PROCESS_QUEUE, failedReason }, 'intake-process job failed');
  });
  const intakeWorker = new Worker<IntakeJobPayload>(
    INTAKE_PROCESS_QUEUE,
    async (job) => {
      const result = await runIntakeProcess(db!, storage!, logger, job.data, {
        sendEmail: dunningSendEmail,
        sendSms: dunningSendSms,
        appBaseUrl: process.env['APP_BASE_URL'],
      });
      logger.info({ jobId: job.id, ...result }, 'intake-process complete');
    },
    { connection, concurrency: 2 },
  );
  intakeWorkerRef = intakeWorker;
  intakeQueueRef = intakeQueue;
  intakeEventsRef = intakeEvents;
  logger.info({ queueName: INTAKE_PROCESS_QUEUE }, 'intake-process queue registered');
}

let intakeWorkerRef: Worker<IntakeJobPayload> | null = null;
let intakeQueueRef: Queue<IntakeJobPayload> | null = null;
let intakeEventsRef: QueueEvents | null = null;

const FILER_ROUTE_QUEUE = 'filer-route';
let filerWorkerRef: Worker<FilerRouteJob> | null = null;
let filerQueueRef: Queue<FilerRouteJob> | null = null;
let filerEventsRef: QueueEvents | null = null;

function setupFilerRouteQueue(): void {
  if (!db || !storage) {
    logger.warn(
      { dbConfigured: Boolean(db), storageConfigured: Boolean(storage) },
      'filer-route queue not registered — db or storage missing',
    );
    return;
  }
  const q = new Queue<FilerRouteJob>(FILER_ROUTE_QUEUE, { connection });
  const events = new QueueEvents(FILER_ROUTE_QUEUE, { connection });
  events.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, queue: FILER_ROUTE_QUEUE, failedReason }, 'filer-route job failed');
  });
  const w = new Worker<FilerRouteJob>(
    FILER_ROUTE_QUEUE,
    async (job) => {
      await runFilerRoute(db!, storage!, logger, job.data);
      logger.info({ jobId: job.id, kind: job.data.kind }, 'filer-route complete');
    },
    { connection, concurrency: 2 },
  );
  filerWorkerRef = w;
  filerQueueRef = q;
  filerEventsRef = events;
  logger.info({ queueName: FILER_ROUTE_QUEUE }, 'filer-route queue registered');
}

// 0153 — Vibe Filer zip import (extract a client document export).
const ZIP_IMPORT_QUEUE = 'zip-import';
let zipImportWorkerRef: Worker<ZipImportJob> | null = null;
let zipImportQueueRef: Queue<ZipImportJob> | null = null;
let zipImportEventsRef: QueueEvents | null = null;

function setupZipImportQueue(): void {
  if (!db || !storage) {
    logger.warn(
      { dbConfigured: Boolean(db), storageConfigured: Boolean(storage) },
      'zip-import queue not registered — db or storage missing',
    );
    return;
  }
  const q = new Queue<ZipImportJob>(ZIP_IMPORT_QUEUE, { connection });
  const events = new QueueEvents(ZIP_IMPORT_QUEUE, { connection });
  events.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, queue: ZIP_IMPORT_QUEUE, failedReason }, 'zip-import job failed');
  });
  const w = new Worker<ZipImportJob>(
    ZIP_IMPORT_QUEUE,
    async (job) => {
      await runZipImport(db!, storage!, logger, job.data);
      logger.info({ jobId: job.id, importId: job.data.importId }, 'zip-import complete');
    },
    { connection, concurrency: 1 },
  );
  zipImportWorkerRef = w;
  zipImportQueueRef = q;
  zipImportEventsRef = events;
  logger.info({ queueName: ZIP_IMPORT_QUEUE }, 'zip-import queue registered');
}

const INTERNAL_MESSAGE_NOTIFY_QUEUE = 'internal-message-notify';
interface InternalMessageNotifyPayload {
  threadId: string;
  messageId: string;
  firmId: string;
  senderAppUserId: string;
}

function setupInternalMessageNotifyQueue(): void {
  if (!db) {
    logger.warn('internal-message-notify queue not registered — db missing');
    return;
  }
  const q = new Queue<InternalMessageNotifyPayload>(INTERNAL_MESSAGE_NOTIFY_QUEUE, { connection });
  const evt = new QueueEvents(INTERNAL_MESSAGE_NOTIFY_QUEUE, { connection });
  evt.on('failed', ({ jobId, failedReason }) => {
    logger.error(
      { jobId, queue: INTERNAL_MESSAGE_NOTIFY_QUEUE, failedReason },
      'internal-message-notify job failed',
    );
  });
  const w = new Worker<InternalMessageNotifyPayload>(
    INTERNAL_MESSAGE_NOTIFY_QUEUE,
    async (job) => {
      const result = await runInternalMessageNotify(db!, logger, job.data, {
        sendEmail: dunningSendEmail,
        sendSms: dunningSendSms,
        appBaseUrl: process.env['APP_BASE_URL'],
      });
      logger.info({ jobId: job.id, ...result }, 'internal-message-notify complete');
    },
    { connection, concurrency: 2 },
  );
  imNotifyWorkerRef = w;
  imNotifyQueueRef = q;
  imNotifyEventsRef = evt;
  logger.info(
    { queueName: INTERNAL_MESSAGE_NOTIFY_QUEUE },
    'internal-message-notify queue registered',
  );
}

let imNotifyWorkerRef: Worker<InternalMessageNotifyPayload> | null = null;
let imNotifyQueueRef: Queue<InternalMessageNotifyPayload> | null = null;
let imNotifyEventsRef: QueueEvents | null = null;

const apptWorkerRefs: Worker<ProviderJob>[] = [];
const apptEventRefs: QueueEvents[] = [];

function setupAppointmentProviderQueues(): void {
  if (!db) {
    logger.warn('appointment provider queues not registered — db missing');
    return;
  }
  const defs: Array<
    [string, (deps: ProviderJobDeps, job: ProviderJob) => Promise<ProviderJobResult>]
  > = [
    [APPOINTMENT_PROVIDER_WRITE_QUEUE, runAppointmentProviderWrite],
    [APPOINTMENT_PROVIDER_UPDATE_QUEUE, runAppointmentProviderUpdate],
    [APPOINTMENT_PROVIDER_DELETE_QUEUE, runAppointmentProviderDelete],
  ];
  for (const [name, fn] of defs) {
    const evt = new QueueEvents(name, { connection });
    evt.on('failed', ({ jobId, failedReason }) => {
      logger.error({ jobId, queue: name, failedReason }, 'appointment provider job failed');
    });
    const w = new Worker<ProviderJob>(
      name,
      async (job) => {
        const result = await fn({ db: db! }, job.data);
        logger.info({ jobId: job.id, queue: name, result }, 'appointment provider job complete');
      },
      { connection, concurrency: 3 },
    );
    apptWorkerRefs.push(w);
    apptEventRefs.push(evt);
  }
  logger.info({ queues: defs.map((d) => d[0]) }, 'appointment provider queues registered');
}

const apptEmailWorkerRefs: Worker[] = [];
const apptEmailEventRefs: QueueEvents[] = [];

function setupAppointmentEmailQueues(): void {
  if (!db) {
    logger.warn('appointment email queues not registered — db missing');
    return;
  }
  const appBaseUrl = process.env['APP_BASE_URL'];
  const sendEmail: SendAppointmentEmail = async (mail) => {
    if (!dunningSendEmail) return;
    // The .ics is attached as appointment.ics so recipients get a real
    // calendar invite (SMTP/Postmark/Resend all carry it now).
    await dunningSendEmail({ to: mail.to, subject: mail.subject, body: mail.body, ics: mail.ics });
  };
  const register = <T>(name: string, run: (job: { data: T }) => Promise<unknown>): void => {
    const evt = new QueueEvents(name, { connection });
    evt.on('failed', ({ jobId, failedReason }) => {
      logger.error({ jobId, queue: name, failedReason }, 'appointment email job failed');
    });
    const w = new Worker<T>(
      name,
      async (job) => {
        const result = await run(job);
        logger.info({ jobId: job.id, queue: name, result }, 'appointment email job complete');
      },
      { connection, concurrency: 2 },
    );
    apptEmailWorkerRefs.push(w as unknown as Worker);
    apptEmailEventRefs.push(evt);
  };
  register<AppointmentJob>(APPOINTMENT_CONFIRMATION_QUEUE, (job) =>
    runAppointmentConfirmationSend({ db: db!, sendEmail, appBaseUrl }, job.data),
  );
  register<AppointmentJob>(APPOINTMENT_RESCHEDULE_CONFIRMATION_QUEUE, (job) =>
    runAppointmentRescheduleConfirmationSend({ db: db!, sendEmail, appBaseUrl }, job.data),
  );
  register<CancellationJob>(APPOINTMENT_CANCELLATION_QUEUE, (job) =>
    runAppointmentCancellationSend({ db: db!, sendEmail, appBaseUrl }, job.data),
  );
  register<AppointmentJob>(APPOINTMENT_DECLINE_QUEUE, (job) =>
    runAppointmentDeclineSend({ db: db!, sendEmail, appBaseUrl }, job.data),
  );
  register<RescheduleRequestedStaffJob>(APPOINTMENT_RESCHEDULE_REQUESTED_STAFF_QUEUE, (job) =>
    runAppointmentRescheduleRequestedStaffSend({ db: db!, sendEmail, appBaseUrl }, job.data),
  );
  logger.info('appointment email queues registered');
}

function setupStorageMutationQueue(): void {
  if (!db || !storage) {
    logger.warn(
      { dbConfigured: Boolean(db), storageConfigured: Boolean(storage) },
      'storage-mutation queue not registered — db or storage missing',
    );
    return;
  }
  const queueName = 'storage-mutation';
  const publishConn = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const mutationQueue = new Queue<FolderRenamePayload>(queueName, { connection });
  const mutationEvents = new QueueEvents(queueName, { connection });
  mutationEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, queue: queueName, failedReason }, 'storage-mutation job failed');
  });
  const mutationWorker = new Worker<FolderRenamePayload>(
    queueName,
    async (job) => {
      if (job.name !== 'folder-rename') {
        logger.warn({ jobId: job.id, name: job.name }, 'storage-mutation: unknown job name');
        return;
      }
      const result = await runFolderRename(
        {
          db: db!,
          storage: storage!,
          log: logger,
          publish: async (channel, message) => {
            await publishConn.publish(channel, message);
          },
        },
        job.data,
      );
      logger.info({ jobId: job.id, ...result }, 'storage-mutation folder-rename complete');
    },
    {
      connection,
      // One mutation per folder at a time is enforced by the
      // status='renaming' CAS in the orchestrator. Worker concurrency
      // of 2 lets renames on distinct folders run in parallel.
      concurrency: 2,
    },
  );
  // Track for graceful shutdown.
  mutationWorkerRef = mutationWorker;
  mutationQueueRef = mutationQueue;
  mutationEventsRef = mutationEvents;
  publishConnRef = publishConn;
  logger.info({ queueName }, 'storage-mutation queue registered');
}

// Refs for graceful shutdown of the parameterized queue.
let mutationWorkerRef: Worker<FolderRenamePayload> | null = null;
let mutationQueueRef: Queue<FolderRenamePayload> | null = null;
let mutationEventsRef: QueueEvents | null = null;
let publishConnRef: IORedis | null = null;

// R4-followup — refs for graceful shutdown of the retainer delayed
// queues. Same parallel-registration pattern as setupStorageMutationQueue:
// the API enqueues delayed jobs with deterministic jobIds; these workers
// consume them at the delay's elapse.
let offerReminderQueueRef: Queue<OfferReminderJobPayload> | null = null;
let offerReminderEventsRef: QueueEvents | null = null;
let offerReminderWorkerRef: Worker<OfferReminderJobPayload> | null = null;
let expiryWarningQueueRef: Queue<ExpiryWarningJobPayload> | null = null;
let expiryWarningEventsRef: QueueEvents | null = null;
let expiryWarningWorkerRef: Worker<ExpiryWarningJobPayload> | null = null;
let stagedNotifQueueRef: Queue<StagedNotificationSendPayload> | null = null;
let stagedNotifEventsRef: QueueEvents | null = null;
let stagedNotifWorkerRef: Worker<StagedNotificationSendPayload> | null = null;

// 0146 — staged client-notification sends. The API enqueues delayed
// jobs at decision time (send-now / schedule / IMMEDIATE staging);
// the handler re-checks guards against the row and fans out per
// channel. attempts:1 — failures surface as FAILED rows with a Retry
// action in the Approvals queue, never as blind re-sends.
function setupStagedNotificationQueue(): void {
  if (!db) {
    logger.warn('staged-notification queue not registered — db missing');
    return;
  }
  const name = 'staged-notification-send';
  stagedNotifQueueRef = new Queue<StagedNotificationSendPayload>(name, { connection });
  stagedNotifEventsRef = new QueueEvents(name, { connection });
  stagedNotifEventsRef.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, queue: name, failedReason }, 'staged notification send failed');
  });
  stagedNotifWorkerRef = new Worker<StagedNotificationSendPayload>(
    name,
    async (job) => {
      const result = await runStagedNotificationSend(
        db!,
        logger,
        { sendEmail: dunningSendEmail, sendSms: dunningSendSms },
        job.data,
      );
      logger.info({ jobId: job.id, ...result }, 'staged-notification-send complete');
    },
    { connection, concurrency: 2 },
  );
  logger.info({ queue: name }, 'staged-notification queue registered');
}

function setupRetainerDelayedQueues(): void {
  if (!db) {
    logger.warn('retainer delayed queues not registered — db missing');
    return;
  }
  const offerName = 'retainer-offer-reminder';
  offerReminderQueueRef = new Queue<OfferReminderJobPayload>(offerName, { connection });
  offerReminderEventsRef = new QueueEvents(offerName, { connection });
  offerReminderEventsRef.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, queue: offerName, failedReason }, 'retainer offer reminder failed');
  });
  offerReminderWorkerRef = new Worker<OfferReminderJobPayload>(
    offerName,
    instrumentRetainerJob(offerName, async (job) => {
      const result = await runRetainerOfferReminder(
        db!,
        logger,
        {
          sendEmail: dunningSendEmail,
          portalBaseUrl: process.env['PORTAL_BASE_URL'],
        },
        job.data,
      );
      logger.info({ jobId: job.id, ...result }, 'retainer-offer-reminder complete');
    }),
    { connection, concurrency: 2 },
  );

  const warningName = 'retainer-expiry-warning';
  expiryWarningQueueRef = new Queue<ExpiryWarningJobPayload>(warningName, { connection });
  expiryWarningEventsRef = new QueueEvents(warningName, { connection });
  expiryWarningEventsRef.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, queue: warningName, failedReason }, 'retainer expiry warning failed');
  });
  expiryWarningWorkerRef = new Worker<ExpiryWarningJobPayload>(
    warningName,
    instrumentRetainerJob(warningName, async (job) => {
      const result = await runRetainerExpiryWarning(
        db!,
        logger,
        {
          sendEmail: dunningSendEmail,
          portalBaseUrl: process.env['PORTAL_BASE_URL'],
        },
        job.data,
      );
      logger.info({ jobId: job.id, ...result }, 'retainer-expiry-warning complete');
    }),
    { connection, concurrency: 2 },
  );

  logger.info({ queues: [offerName, warningName] }, 'retainer delayed-job queues registered');
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
    if (req.url === '/metrics') {
      // Phase 12 of FILE_MANAGER_ADDENDUM.md — Prometheus exposition.
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(renderPrometheusText());
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
  if (mutationWorkerRef) await mutationWorkerRef.close();
  if (mutationQueueRef) await mutationQueueRef.close();
  if (mutationEventsRef) await mutationEventsRef.close();
  if (offerReminderWorkerRef) await offerReminderWorkerRef.close();
  if (offerReminderQueueRef) await offerReminderQueueRef.close();
  if (offerReminderEventsRef) await offerReminderEventsRef.close();
  if (expiryWarningWorkerRef) await expiryWarningWorkerRef.close();
  if (expiryWarningQueueRef) await expiryWarningQueueRef.close();
  if (expiryWarningEventsRef) await expiryWarningEventsRef.close();
  if (stagedNotifWorkerRef) await stagedNotifWorkerRef.close();
  if (stagedNotifQueueRef) await stagedNotifQueueRef.close();
  if (stagedNotifEventsRef) await stagedNotifEventsRef.close();
  if (intakeWorkerRef) await intakeWorkerRef.close();
  if (intakeQueueRef) await intakeQueueRef.close();
  if (intakeEventsRef) await intakeEventsRef.close();
  if (filerWorkerRef) await filerWorkerRef.close();
  if (filerQueueRef) await filerQueueRef.close();
  if (filerEventsRef) await filerEventsRef.close();
  if (zipImportWorkerRef) await zipImportWorkerRef.close();
  if (zipImportQueueRef) await zipImportQueueRef.close();
  if (zipImportEventsRef) await zipImportEventsRef.close();
  if (imNotifyWorkerRef) await imNotifyWorkerRef.close();
  if (imNotifyQueueRef) await imNotifyQueueRef.close();
  if (imNotifyEventsRef) await imNotifyEventsRef.close();
  if (publishConnRef) await publishConnRef.quit();
  await connection.quit();
  if (closeDb) await closeDb();
}

setup().catch((err: unknown) => {
  logger.error({ err }, 'worker boot fatal');
  process.exit(1);
});

// QA fix — keep the worker process alive on stray unhandled rejections
// (e.g. a downstream API call that throws past a forgotten `.catch`).
// BullMQ already retries job failures; we only need to make sure the
// outer node process doesn't exit between ticks.
process.on('unhandledRejection', (reason, promise) => {
  logger.error(
    { reason, promise: String(promise) },
    'unhandled promise rejection — kept worker alive',
  );
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception — kept worker alive');
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
