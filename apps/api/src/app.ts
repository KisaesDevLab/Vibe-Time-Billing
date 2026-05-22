// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import express, { type Express, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import type { Redis } from 'ioredis';
import { sql as drizzleSql } from 'drizzle-orm';

const sqlOne = drizzleSql`SELECT 1`;

import { loadConfig } from './config';
import { logger } from './logger';
import { createStaffAuthRouter, type StaffRoutesDeps } from './auth/staff-routes';
import { staffAuthDeps } from './auth/middleware';
import type { SessionStore } from './auth/session-store';
import type { Database } from '@vibe/db';
import { createAdminRouter } from './admin/routes';
import { buildStorageAdapter } from './files/storage';
import { createMessagingRouter } from './messaging/routes';
import { createTemplateRouter } from './admin/templates';
import { createTaxonomyRouter } from './taxonomy/routes';
import { createTemplatePackRouter } from './taxonomy/templates';
import { createClientRouter } from './clients/routes';
// internal-files + folder-templates routers removed in Phase 0 of the
// file-manager rebuild. Replacements ship in Phases 4 + 10.
import { createEngagementRouter } from './engagements/routes';
import { createTimeEntryRouter } from './time-entries/routes';
import { createPortalAuthRouter, type PortalRoutesDeps } from './auth/portal-routes';
import { portalAuthDeps } from './auth/portal-middleware';
import { createAuditRouter } from './audit/routes';
import { createBillingBatchRouter } from './billing-batches/routes';
import { createAdjustmentRouter } from './adjustments/routes';
import { createReportRouter } from './reports/routes';
import { createSavedReportsRouter } from './reports/saved';
import { createSearchRouter } from './search/routes';
import { createInvoiceRouter } from './invoices/routes';
import { createArRouter } from './ar/routes';
import { createApprovalRouter } from './approvals/routes';
import { createPortalInvoiceRouter } from './portal/invoices';
import { createPortalProfileRouter } from './portal/profile';
import { createPortalLetterRouter } from './portal/letters';
import { createAdminJobRouter } from './admin/jobs';
import { createComplianceRouter } from './admin/compliance';
import { createStorageOnboardingRouter } from './admin/storage-onboarding';
import { createVisibilityRulesRouter } from './admin/visibility-rules';
import { createFileVisibilityRouter } from './files/visibility';
import { createConnectRouter } from './connect/routes';
import { createStatsRouter } from './stats/routes';
import { createEngagementLetterRouter } from './engagement-letters/routes';
import { createRequiredFieldRulesRouter } from './required-field-rules/routes';
import { createAttachmentRouter } from './attachments/routes';
import { createRestV1Router } from './rest-v1/routes';
import { createMcpRouter } from './mcp/routes';
import { createAiRouter } from './ai/routes';
import { createApiTokenRouter } from './admin/api-tokens';
import { createStripeWebhookRouter } from './webhooks/stripe';
import { createCpaChargeWebhookRouter } from './webhooks/cpacharge';
import { createWebhookRouter } from './webhooks/outbound';
import { createPortalInviteRouter } from './portal-invites/routes';
import { createRecurringPlanRouter } from './recurring-plans/routes';
import { createHourBankRouter } from './hour-banks/routes';
import { createPaymentRouter } from './payments/routes';
import { createRateRouter } from './rates/routes';
import { createHolidayRouter } from './holidays/routes';
import { createMilestoneRouter } from './milestones/routes';
import type { AiProvider } from '@vibe/core/ai';
import type { PaymentProvider } from '@vibe/core/payments';
import type { RoleSlug } from '@vibe/core/rbac';

export interface AppDeps {
  db: Database | null;
  redis: Redis;
  sessionStore: SessionStore;
  sendMagicLink?: StaffRoutesDeps['sendMagicLink'];
  sendPortalEmail?: PortalRoutesDeps['sendEmail'];
  sendPortalSms?: PortalRoutesDeps['sendSms'];
  // Optional payment provider hook. In dev/test the portal pay endpoint
  // returns 402 if no provider is wired; production injects the Stripe
  // client (apps/api/src/payments/stripe.ts) per the firm's BYO keys.
  chargeInvoice?: (args: {
    invoiceId: string;
    amountCents: number;
    metadata: Record<string, string>;
  }) => Promise<{ ok: boolean; providerChargeId?: string; errorMessage?: string }>;
  cloudAiProvider?: AiProvider | null;
  localAiProvider?: AiProvider | null;
  stripeProvider?: PaymentProvider | null;
  stripeWebhookSecret?: string | null;
  fakeUserRoles?: Map<string, RoleSlug[]>;
}

export function createApp(deps: AppDeps): Express {
  const config = loadConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  // Liveness — used by Docker HEALTHCHECK. Cheap, no I/O.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'vibe-time-billing-api',
      env: config.NODE_ENV,
      portalEnabled: Boolean(config.COMMERCIAL_LICENSE_TOKEN),
    });
  });

  // Per-service health probes — each external dep gets its own URL so a
  // load-balancer or monitoring system can target it specifically.
  app.get('/health/db', async (_req: Request, res: Response) => {
    try {
      if (deps.db) {
        await deps.db.execute(sqlOne);
        res.json({ status: 'ok', service: 'db' });
        return;
      }
      res.status(503).json({ status: 'no_db', service: 'db' });
    } catch (err) {
      res
        .status(503)
        .json({ status: 'down', service: 'db', error: err instanceof Error ? err.message : '?' });
    }
  });
  app.get('/health/redis', async (_req: Request, res: Response) => {
    try {
      const pong = await deps.redis.ping();
      if (pong === 'PONG') {
        res.json({ status: 'ok', service: 'redis' });
        return;
      }
      res.status(503).json({ status: 'unexpected_reply', service: 'redis', reply: pong });
    } catch (err) {
      res.status(503).json({
        status: 'down',
        service: 'redis',
        error: err instanceof Error ? err.message : '?',
      });
    }
  });

  // Prometheus-style text exposition. Minimal — counts only, since we
  // don't run a real metrics library in-process. Tags include service name
  // so Prometheus can group across the api/worker pair.
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    const lines: string[] = [];
    lines.push('# HELP vibe_up Whether the API process is up.');
    lines.push('# TYPE vibe_up gauge');
    lines.push(`vibe_up{service="api"} 1`);
    // Memory.
    const mem = process.memoryUsage();
    lines.push('# HELP vibe_process_rss_bytes Resident set size in bytes.');
    lines.push('# TYPE vibe_process_rss_bytes gauge');
    lines.push(`vibe_process_rss_bytes{service="api"} ${mem.rss}`);
    lines.push('# HELP vibe_process_heap_used_bytes Heap used in bytes.');
    lines.push('# TYPE vibe_process_heap_used_bytes gauge');
    lines.push(`vibe_process_heap_used_bytes{service="api"} ${mem.heapUsed}`);
    // Uptime.
    lines.push('# HELP vibe_process_uptime_seconds Process uptime.');
    lines.push('# TYPE vibe_process_uptime_seconds counter');
    lines.push(`vibe_process_uptime_seconds{service="api"} ${process.uptime().toFixed(2)}`);
    res.send(lines.join('\n') + '\n');
  });

  // Readiness — surfaces what's actually wired vs. stubbed. Used by the
  // admin dashboard's "system status" panel.
  app.get('/health/ready', async (_req: Request, res: Response) => {
    let dbOk = false;
    let dbError: string | undefined;
    try {
      if (deps.db) {
        // Trivial round-trip; doesn't allocate anything.
        await deps.db.execute(sqlOne);
        dbOk = true;
      }
    } catch (err) {
      dbError = err instanceof Error ? err.message : 'db_unreachable';
    }
    let redisOk = false;
    try {
      const pong = await deps.redis.ping();
      redisOk = pong === 'PONG';
    } catch {
      redisOk = false;
    }
    res.json({
      status: dbOk && redisOk ? 'ready' : 'degraded',
      checks: { db: dbOk, redis: redisOk, dbError },
      wiring: {
        stripe: Boolean(deps.chargeInvoice),
        aiCloud: Boolean(deps.cloudAiProvider),
        aiLocal: Boolean(deps.localAiProvider),
        portalEnabled: Boolean(config.COMMERCIAL_LICENSE_TOKEN),
      },
    });
  });

  // Public auth surface: /login, /verify-magic-link
  // Authenticated auth surface: /totp/enroll, /totp/verify, /logout, /me
  const auth = staffAuthDeps(deps.sessionStore);

  const authRouter = createStaffAuthRouter({
    ...deps,
    sendMagicLink: deps.sendMagicLink ?? (async () => undefined),
    requireAuth: auth.requireAuth,
  });
  app.use('/api/auth', authRouter);

  // Protect everything else under /api/staff/* with requireAuth.
  app.use('/api/staff', auth.requireAuth, auth.requireCsrf);
  app.get('/api/staff/whoami', (req, res) => {
    res.json({ session: req.staffSession });
  });

  const adminRouter = createAdminRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/admin', auth.requireAuth, auth.requireCsrf, adminRouter);

  const messagingRouter = createMessagingRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/admin/messaging', auth.requireAuth, auth.requireCsrf, messagingRouter);

  const templateRouter = createTemplateRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/admin/templates', auth.requireAuth, auth.requireCsrf, templateRouter);

  const taxonomyRouter = createTaxonomyRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/taxonomy', auth.requireAuth, auth.requireCsrf, taxonomyRouter);

  const templatePackRouter = createTemplatePackRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/taxonomy', auth.requireAuth, auth.requireCsrf, templatePackRouter);

  // v2 Sprint C — file storage adapter. Selection is env-driven; safe
  // to build at boot since LocalFsAdapter doesn't touch the filesystem
  // until a put/get runs.
  const storage = buildStorageAdapter();
  const clientRouter = createClientRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    storage,
    redis: deps.redis,
  });
  app.use('/api/staff/clients', auth.requireAuth, auth.requireCsrf, clientRouter);

  // v1 internal-files + folder-templates routers removed in Phase 0
  // of the file-manager rebuild. Replacements ship in Phases 4 + 10
  // (storage onboarding + per-client UI per FILE_MANAGER_ADDENDUM.md).

  const engagementRouter = createEngagementRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/engagements', auth.requireAuth, auth.requireCsrf, engagementRouter);

  const timeEntryRouter = createTimeEntryRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    redis: deps.redis,
  });
  app.use('/api/staff/time-entries', auth.requireAuth, auth.requireCsrf, timeEntryRouter);

  const auditRouter = createAuditRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/audit', auth.requireAuth, auth.requireCsrf, auditRouter);

  const billingBatchRouter = createBillingBatchRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    sendEmail: deps.sendPortalEmail,
  });
  app.use('/api/staff/billing-batches', auth.requireAuth, auth.requireCsrf, billingBatchRouter);

  const adjustmentRouter = createAdjustmentRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    requireStepUp: auth.requireStepUp,
    sendEmail: deps.sendPortalEmail,
    staffBaseUrl: config.APP_BASE_URL,
  });
  app.use('/api/staff/adjustments', auth.requireAuth, auth.requireCsrf, adjustmentRouter);

  const reportRouter = createReportRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/reports', auth.requireAuth, auth.requireCsrf, reportRouter);

  const savedReportsRouter = createSavedReportsRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/saved-reports', auth.requireAuth, auth.requireCsrf, savedReportsRouter);

  const searchRouter = createSearchRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/search', auth.requireAuth, auth.requireCsrf, searchRouter);

  const invoiceRouter = createInvoiceRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    sendEmail: deps.sendPortalEmail,
    portalBaseUrl: config.PORTAL_BASE_URL,
    paymentProvider: deps.stripeProvider ?? null,
  });
  app.use('/api/staff/invoices', auth.requireAuth, auth.requireCsrf, invoiceRouter);

  const arRouter = createArRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    sendEmail: deps.sendPortalEmail,
    portalBaseUrl: config.PORTAL_BASE_URL,
  });
  app.use('/api/staff/ar', auth.requireAuth, auth.requireCsrf, arRouter);

  const approvalRouter = createApprovalRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/approvals', auth.requireAuth, auth.requireCsrf, approvalRouter);

  // Portal auth realm — distinct middleware, signing key, cookie.
  // Phase 16 #27 — unauth status endpoint so the portal SPA can render
  // a clear 'portal disabled' page without trying to log in.
  app.get('/api/portal/status', async (_req, res) => {
    const cfgLocal = config;
    const licensed = Boolean(cfgLocal.COMMERCIAL_LICENSE_TOKEN);
    let firmEnabled = true;
    if (deps.db && licensed) {
      try {
        const { firmSettings } = await import('@vibe/db/schema');
        const [first] = await deps.db
          .select({ enabled: firmSettings.portalEnabled })
          .from(firmSettings)
          .limit(1);
        firmEnabled = first?.enabled ?? true;
      } catch {
        // no-op
      }
    }
    res.json({ licensed, firmEnabled, enabled: licensed && firmEnabled });
  });
  const portal = portalAuthDeps(deps.sessionStore, deps.db);
  const portalRouter = createPortalAuthRouter({
    db: deps.db,
    redis: deps.redis,
    sessionStore: deps.sessionStore,
    sendEmail: deps.sendPortalEmail ?? (async () => undefined),
    sendSms: deps.sendPortalSms ?? (async () => undefined),
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/auth', portalRouter);

  const portalInvoiceRouter = createPortalInvoiceRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
    chargeInvoice: deps.chargeInvoice,
  });
  app.use('/api/portal/invoices', portalInvoiceRouter);

  const portalProfileRouter = createPortalProfileRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
    sessionStore: deps.sessionStore,
  });
  app.use('/api/portal/profile', portalProfileRouter);

  const portalLetterRouter = createPortalLetterRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/letters', portalLetterRouter);

  // REST v1 — token-authenticated integrator surface.
  app.use('/api/v1', createRestV1Router({ db: deps.db, redis: deps.redis }));

  // MCP HTTP shim — token-authenticated agent surface.
  app.use('/mcp', createMcpRouter({ db: deps.db }));

  // AI feature endpoints — staff realm.
  const aiRouter = createAiRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    cloudProvider: deps.cloudAiProvider ?? null,
    localProvider: deps.localAiProvider ?? null,
  });
  app.use('/api/staff/ai', auth.requireAuth, auth.requireCsrf, aiRouter);

  const statsRouter = createStatsRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/stats', auth.requireAuth, auth.requireCsrf, statsRouter);

  const engagementLetterRouter = createEngagementLetterRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    sendEmail: deps.sendPortalEmail,
    portalBaseUrl: config.PORTAL_BASE_URL,
  });
  app.use(
    '/api/staff/engagement-letters',
    auth.requireAuth,
    auth.requireCsrf,
    engagementLetterRouter,
  );

  const requiredFieldRulesRouter = createRequiredFieldRulesRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/required-field-rules',
    auth.requireAuth,
    auth.requireCsrf,
    requiredFieldRulesRouter,
  );

  const attachmentRouter = createAttachmentRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/attachments', auth.requireAuth, auth.requireCsrf, attachmentRouter);

  const adminJobRouter = createAdminJobRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    redisUrl: config.REDIS_URL,
  });
  app.use('/api/staff/admin/jobs', auth.requireAuth, auth.requireCsrf, adminJobRouter);

  const complianceRouter = createComplianceRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/admin/compliance', auth.requireAuth, auth.requireCsrf, complianceRouter);

  // Phase 4 of FILE_MANAGER_ADDENDUM.md — storage onboarding.
  const storageOnboardingRouter = createStorageOnboardingRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/admin/storage', auth.requireAuth, auth.requireCsrf, storageOnboardingRouter);

  // Phase 6 of FILE_MANAGER_ADDENDUM.md — firm-level visibility rules.
  const visibilityRulesRouter = createVisibilityRulesRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/admin/visibility-rules',
    auth.requireAuth,
    auth.requireCsrf,
    visibilityRulesRouter,
  );

  // Phase 6 of FILE_MANAGER_ADDENDUM.md — per-file visibility flips.
  const fileVisibilityRouter = createFileVisibilityRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/files', auth.requireAuth, auth.requireCsrf, fileVisibilityRouter);

  const connectRouter = createConnectRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    connectBaseUrl: process.env['VIBE_CONNECT_BASE_URL'] ?? null,
    connectApiKey: process.env['VIBE_CONNECT_API_KEY'] ?? null,
  });
  app.use('/api/staff/connect', auth.requireAuth, auth.requireCsrf, connectRouter);

  // API token issuance — admin only.
  const apiTokenRouter = createApiTokenRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/admin/api-tokens', auth.requireAuth, auth.requireCsrf, apiTokenRouter);

  const recurringPlanRouter = createRecurringPlanRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/recurring-plans', auth.requireAuth, auth.requireCsrf, recurringPlanRouter);

  const hourBankRouter = createHourBankRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/hour-banks', auth.requireAuth, auth.requireCsrf, hourBankRouter);

  const paymentRouter = createPaymentRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/payments', auth.requireAuth, auth.requireCsrf, paymentRouter);

  const rateRouter = createRateRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/rates', auth.requireAuth, auth.requireCsrf, rateRouter);

  const holidayRouter = createHolidayRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/holidays', auth.requireAuth, auth.requireCsrf, holidayRouter);

  const milestoneRouter = createMilestoneRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/milestones', auth.requireAuth, auth.requireCsrf, milestoneRouter);

  // Portal invitation (firm-side).
  const portalInviteRouter = createPortalInviteRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    sendEmail: deps.sendPortalEmail,
    sendSms: deps.sendPortalSms,
    portalBaseUrl: config.PORTAL_BASE_URL,
  });
  app.use('/api/staff/portal-invites', auth.requireAuth, auth.requireCsrf, portalInviteRouter);

  const webhookRouter = createWebhookRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/webhooks', auth.requireAuth, auth.requireCsrf, webhookRouter);

  // Stripe webhook — mounted BEFORE the global JSON body parser would
  // have run, so the raw body is preserved for signature verification.
  // Express routes the call to this router's raw-body parser first.
  app.use(
    '/api/webhooks/stripe',
    createStripeWebhookRouter({
      db: deps.db,
      stripe: deps.stripeProvider ?? null,
      webhookSecret: deps.stripeWebhookSecret ?? null,
      sendEmail: deps.sendPortalEmail,
      portalBaseUrl: config.PORTAL_BASE_URL,
    }),
  );

  app.use(
    '/api/webhooks/cpacharge',
    createCpaChargeWebhookRouter({
      db: deps.db,
      provider: null,
      webhookSecret: process.env['CPACHARGE_WEBHOOK_SECRET'] ?? null,
    }),
  );

  return app;
}
