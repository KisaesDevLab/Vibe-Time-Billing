// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
// QA fix — express-async-errors patches Express 4's Layer.handle to
// await async handlers and forward rejections to the error
// middleware. Without it, an async handler that throws (e.g. a
// failed DB query) just sits — the response is never sent and the
// client hangs. Must be imported BEFORE express is used.
import 'express-async-errors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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
import { createUnlockRouter, createLockMiddleware } from './admin/unlock';
import { requireStepUpWithLockout } from './auth/step-up-middleware';
import { createEngagementMessagingRouter } from './engagement-messaging/routes';
import { createRequestRouter } from './requests/routes';
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
import { mountRetainerHealth, collectRetainerMetricsText } from './health/retainer-health';
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
import { createStatementsRouter } from './statements/routes';
import { createApprovalRouter } from './approvals/routes';
import { createPortalInvoiceRouter } from './portal/invoices';
import { createPortalProfileRouter } from './portal/profile';
import { createPortalRetainerOfferRouter } from './portal/retainer-offers';
import { createPortalActivityRouter } from './portal/activity';
import { createPortalAppointmentRouter } from './portal/appointments';
import { createPortalEngagementAutopayRouter } from './portal/engagement-autopay';
import { createPortalEngagementRouter } from './portal/engagements';
import { createPortalFileShareRouter } from './portal/file-shares';
import { createSharePublicRouter } from './share-public';
import { createPortalRetainerRouter } from './portal/retainers';
import { createPortalTaxPaymentRouter } from './portal/tax-payments';
import { createPortalStepUpRouter } from './portal/step-up';
import { createPortalLetterRouter } from './portal/letters';
import { createPortalFileRouter } from './portal/files';
import { createPortalMessagingRouter } from './portal/messaging';
import { createPortalRequestsRouter } from './portal/requests';
import { createAdminJobRouter } from './admin/jobs';
import { createComplianceRouter } from './admin/compliance';
import { createStorageOnboardingRouter } from './admin/storage-onboarding';
import { createStorageMockUploadRouter } from './admin/storage-mock-upload';
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
import { createStripeConnectWebhookRouter } from './webhooks/stripe-connect';
import { createCpaChargeWebhookRouter } from './webhooks/cpacharge';
import { createWebhookRouter } from './webhooks/outbound';
import { createPortalInviteRouter } from './portal-invites/routes';
import { createRecurringPlanRouter } from './recurring-plans/routes';
import { createHourBankRouter } from './hour-banks/routes';
import { createRetainerConfigRouter } from './retainers-config/routes';
import { createAppointmentRouter } from './appointments/routes';
import { createServiceRouter } from './services-catalog/routes';
import { createServiceTagRouter } from './services-catalog/tags';
import { createPackageRouter } from './packages/routes';
import { createTermsTemplateRouter } from './terms-templates/routes';
import { createProposalRouter } from './proposals/routes';
import { createPortalMagicLinkRouter, createStaffMagicLinkRouter } from './proposals/magic-links';
import { createStripeConnectRouter } from './stripe-connect/routes';
import { createRetainerRouter } from './retainers/routes';
import { createTaxPaymentRouter } from './tax-payments/routes';
import { createPaymentRouter } from './payments/routes';
import { createCreditRouter } from './credits/routes';
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
  /** 0054 — full-payload mail (HTML body, attachments) for statement + invoice emails. */
  sendStaffMail?: (args: {
    to: string;
    subject: string;
    body: string;
    html?: string;
    attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  }) => Promise<void>;
  sendPortalSms?: PortalRoutesDeps['sendSms'];
  /**
   * P4.6 — I.6 — fired when a portal step-up lockout trips. Notifies
   * firm admins (template `step_up_lockout`). Optional; if absent the
   * lockout still happens, the alert just isn't sent.
   */
  sendStepUpLockoutAlert?: (args: {
    firmId: string;
    portalIdentityId: string;
    expiresAt: Date;
  }) => Promise<void>;
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
  //
  // P3.1 — A.11: when the appliance is locked (admin-passphrase mode
  // awaiting /admin/unlock) we return 503 so load balancers and Docker
  // healthcheck mark the container as unhealthy. The lock middleware
  // already allowlists /health itself so this endpoint is always
  // reachable; the body explains the state.
  //
  // `no-firm` state (initial value before bootCrypto resolves, or
  // appliance not yet provisioned) returns 200 — we don't want a fresh
  // container to flap unhealthy during the cold-boot window.
  app.get('/health', async (_req: Request, res: Response) => {
    const { getApplianceLockState } = await import('./crypto/boot');
    const lock = getApplianceLockState();
    const baseBody = {
      service: 'vibe-time-billing-api',
      env: config.NODE_ENV,
      portalEnabled: Boolean(config.COMMERCIAL_LICENSE_TOKEN),
    };
    if (lock.kind === 'locked' || lock.kind === 'not-bootstrapped') {
      res.status(503).json({
        ...baseBody,
        status: 'locked',
        reason: lock.kind === 'locked' ? lock.reason : 'awaiting-bootstrap',
        message:
          'Appliance is awaiting admin passphrase — POST /api/staff/admin/unlock to proceed.',
      });
      return;
    }
    res.json({ ...baseBody, status: 'ok' });
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
    // R6-followup — retainer gauges from DB. Best-effort; failures log.
    if (deps.db) {
      try {
        const retainerLines = await collectRetainerMetricsText(deps.db);
        if (retainerLines) lines.push(retainerLines);
      } catch (err) {
        logger.error({ err }, 'retainer metrics collection failed');
      }
    }
    res.send(lines.join('\n') + '\n');
  });

  // R6-followup — retainer-specific healthcheck. Surfaces 503 when the
  // daily sweeps (retainer-expiry-sweep / retainer-offer-expiry-sweep)
  // haven't reported a heartbeat into Redis within 25h.
  mountRetainerHealth(app, { db: deps.db, redis: deps.redis });

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

  // Stage 1B — appliance unlock surface. Mounted BEFORE the global
  // /api/staff auth gate because /status and /unlock have to work pre-
  // login (the appliance might still be locked, in which case no
  // session can be issued anyway). /lock inside this router opts back
  // into auth via the requireAuth/requireCsrf chain.
  const unlockRouter = createUnlockRouter({
    db: deps.db,
    redis: deps.redis,
    fakeUserRoles: deps.fakeUserRoles,
    requireAuth: auth.requireAuth,
    requireCsrf: auth.requireCsrf,
  });
  app.use('/api/staff/admin/unlock', unlockRouter);

  // Stage 1B — lock middleware. Once mounted, every request below this
  // point gets a 503 if the appliance is locked. The middleware
  // allowlist covers /health/*, /metrics, /api/staff/admin/unlock,
  // and /api/auth (so login flows still work).
  app.use(createLockMiddleware());

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

  // Stage 2 — engagement-level messaging. Distinct prefix from the
  // legacy /messaging/ provider config router (which lives under
  // /api/staff/admin/messaging).
  const engagementMessagingRouter = createEngagementMessagingRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/engagement-messaging',
    auth.requireAuth,
    auth.requireCsrf,
    engagementMessagingRouter,
  );

  // Stage 3 — client requests workflow.
  const requestRouter = createRequestRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/requests', auth.requireAuth, auth.requireCsrf, requestRouter);

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

  // Stage 1B — fresh-TOTP step-up with Redis lockout for sensitive ops.
  // Declared here so adjustments + invoices + credits below can share
  // a single instance.
  const stepUpGuard = requireStepUpWithLockout(deps.redis);

  const adjustmentRouter = createAdjustmentRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    requireStepUp: stepUpGuard,
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
    requireStepUp: stepUpGuard,
  });
  app.use('/api/staff/invoices', auth.requireAuth, auth.requireCsrf, invoiceRouter);

  const arRouter = createArRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    sendEmail: deps.sendPortalEmail,
    portalBaseUrl: config.PORTAL_BASE_URL,
  });
  app.use('/api/staff/ar', auth.requireAuth, auth.requireCsrf, arRouter);

  // 0054 — Statement of Account routes (single + bulk + email).
  const statementsRouter = createStatementsRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    sendStaffMail: deps.sendStaffMail,
  });
  app.use('/api/staff/statements', auth.requireAuth, auth.requireCsrf, statementsRouter);

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

  // R3 — portal retainer offer flow (get / select / decline).
  const portalRetainerOfferRouter = createPortalRetainerOfferRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/retainer-offers', portalRetainerOfferRouter);

  // R6 — portal retainer list + ledger (read-only, privacy-filtered).
  const portalRetainerRouter = createPortalRetainerRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/retainers', portalRetainerRouter);

  // CP2 — portal tax-payments view (read-only, privacy-filtered).
  const portalTaxPaymentRouter = createPortalTaxPaymentRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/tax-payments', portalTaxPaymentRouter);

  // CP4 — portal engagement status board (read-only, privacy-filtered).
  const portalEngagementRouter = createPortalEngagementRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/engagements', portalEngagementRouter);

  // CP6 — portal activity log (read-only, privacy-filtered audit feed).
  const portalActivityRouter = createPortalActivityRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/activity', portalActivityRouter);

  // CP9 — per-engagement autopay enrollment.
  const portalEngagementAutopayRouter = createPortalEngagementAutopayRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/engagement-autopay', portalEngagementAutopayRouter);

  // CP11 — file share-link creation/list/revoke (portal-authenticated).
  const portalFileShareRouter = createPortalFileShareRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
    portalBaseUrl: config.PORTAL_BASE_URL,
  });
  app.use('/api/portal/files', portalFileShareRouter);

  // CP11 — public token-based share access (no portal auth).
  const sharePublicRouter = createSharePublicRouter({ db: deps.db });
  app.use('/api/shared', sharePublicRouter);

  // CP12 — portal appointments (read-only).
  const portalAppointmentRouter = createPortalAppointmentRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/appointments', portalAppointmentRouter);

  // P4.4 — portal step-up challenge endpoints.
  const portalStepUpRouter = createPortalStepUpRouter({
    db: deps.db,
    redis: deps.redis,
    requireAuth: portal.requireAuth,
    sendEmail: deps.sendPortalEmail,
    sendSms: deps.sendPortalSms,
    onLockout: deps.sendStepUpLockoutAlert,
  });
  app.use('/api/portal/step-up', portalStepUpRouter);

  const portalLetterRouter = createPortalLetterRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/letters', portalLetterRouter);

  // Phase 11 of FILE_MANAGER_ADDENDUM.md — portal file listing +
  // presigned downloads with rate limiting + access log.
  const portalFileRouter = createPortalFileRouter({
    db: deps.db,
    redis: deps.redis,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/files', portalFileRouter);

  // Stage 4 — portal-side messaging and requests.
  const portalMessagingRouter = createPortalMessagingRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/messaging', portalMessagingRouter);

  const portalRequestsRouter = createPortalRequestsRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/requests', portalRequestsRouter);

  // REST v1 — token-authenticated integrator surface.
  app.use('/api/v1', createRestV1Router({ db: deps.db, redis: deps.redis }));

  // MCP HTTP shim — token-authenticated agent surface.
  app.use('/mcp', createMcpRouter({ db: deps.db }));

  // AI feature endpoints — staff realm.
  const aiRouter = createAiRouter({
    db: deps.db,
    redis: deps.redis,
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

  // Phase 10 of FILE_MANAGER_ADDENDUM.md — dev-only translator for
  // mock-presign:// upload URLs. Refuses to run when STORAGE_PROVIDER
  // isn't 'mock', so a B2 deploy can't accidentally land here.
  const storageMockUploadRouter = createStorageMockUploadRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/admin/storage', auth.requireAuth, auth.requireCsrf, storageMockUploadRouter);

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

  // R1 — Retainer addendum tier config + firm settings.
  const retainerConfigRouter = createRetainerConfigRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/admin/retainer', auth.requireAuth, auth.requireCsrf, retainerConfigRouter);

  const retainerRouter = createRetainerRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/retainers', auth.requireAuth, auth.requireCsrf, retainerRouter);

  const taxPaymentRouter = createTaxPaymentRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/tax-payments', auth.requireAuth, auth.requireCsrf, taxPaymentRouter);

  // CP12 — appointments (read for everyone with appointment:read,
  // write for partner + manager).
  const appointmentRouter = createAppointmentRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/appointments', auth.requireAuth, auth.requireCsrf, appointmentRouter);

  // P02 — services catalog + tags (proposal addendum). read for
  // partner/manager/senior/staff; write for partner + manager.
  const serviceRouter = createServiceRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/services', auth.requireAuth, auth.requireCsrf, serviceRouter);
  const serviceTagRouter = createServiceTagRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/service-tags', auth.requireAuth, auth.requireCsrf, serviceTagRouter);

  // P03 — packages (Bronze/Silver/Gold). Reuses service:read|write.
  const packageRouter = createPackageRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/packages', auth.requireAuth, auth.requireCsrf, packageRouter);

  // P07 — terms templates (engagement-letter library).
  const termsTemplateRouter = createTermsTemplateRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/terms-templates', auth.requireAuth, auth.requireCsrf, termsTemplateRouter);

  // PP4a — Proposal CRUD. partner = author; manager = read.
  const proposalRouter = createProposalRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/proposals', auth.requireAuth, auth.requireCsrf, proposalRouter);

  // P17 — proposal magic-link mint (staff side). Mounted under the
  // same /proposals path so the URL is /proposals/:id/mint-magic-link.
  const staffMagicLinkRouter = createStaffMagicLinkRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    portalBaseUrl: config.PORTAL_BASE_URL,
  });
  app.use('/api/staff/proposals', auth.requireAuth, auth.requireCsrf, staffMagicLinkRouter);

  // P17 — proposal magic-link redeem (portal side). No portal-auth
  // middleware — the magic link IS the credential.
  const portalMagicLinkRouter = createPortalMagicLinkRouter({
    db: deps.db,
    redis: deps.redis,
  });
  app.use('/api/portal/proposals', portalMagicLinkRouter);

  // P08 — Stripe Connect Standard OAuth.
  const stripeConnectRouter = createStripeConnectRouter({
    db: deps.db,
    redis: deps.redis,
    fakeUserRoles: deps.fakeUserRoles,
    config: {
      clientId: config.STRIPE_CONNECT_CLIENT_ID ?? null,
      secretKey: config.STRIPE_SECRET_KEY ?? null,
      redirectUri: config.STRIPE_CONNECT_REDIRECT_URI ?? null,
    },
  });
  app.use('/api/staff/stripe-connect', auth.requireAuth, auth.requireCsrf, stripeConnectRouter);

  const paymentRouter = createPaymentRouter({
    db: deps.db,
    stripe: deps.stripeProvider ?? null,
    stripePublishableKey: config.STRIPE_PUBLISHABLE_KEY ?? null,
    fakeUserRoles: deps.fakeUserRoles,
    sendEmail: deps.sendPortalEmail,
    portalBaseUrl: config.PORTAL_BASE_URL,
  });
  app.use('/api/staff/payments', auth.requireAuth, auth.requireCsrf, paymentRouter);

  const creditRouter = createCreditRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    redis: deps.redis,
    requireStepUp: stepUpGuard,
  });
  app.use('/api/staff/credits', auth.requireAuth, auth.requireCsrf, creditRouter);

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

  // P12 — separate webhook channel for Stripe Connect events about
  // connected accounts (subscription.*, invoice.*, mandate.updated,
  // account.updated, …). Distinct secret from the BYO-key stripe
  // webhook above.
  app.use(
    '/api/webhooks/stripe-connect',
    createStripeConnectWebhookRouter({
      db: deps.db,
      stripe: deps.stripeProvider ?? null,
      webhookSecret: config.STRIPE_CONNECT_WEBHOOK_SECRET ?? null,
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

  // QA fix — Express 4 error-handler middleware. Paired with
  // express-async-errors at the top of this file: any thrown
  // exception or rejected promise inside a route handler lands here
  // instead of stranding the request. Returns a generic 500 with the
  // request id; full detail is in the log so we don't leak stack
  // traces to clients.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as Request & { id?: string }).id;
    logger.error(
      {
        err,
        url: req.url,
        method: req.method,
        requestId,
      },
      'unhandled error in route handler',
    );
    if (res.headersSent) return;
    res.status(500).json({
      error: 'internal_error',
      requestId: requestId ?? null,
    });
  });

  return app;
}
