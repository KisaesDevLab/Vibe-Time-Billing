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
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { buildStorageClient, type StorageClient } from '@vibe/storage';
import { firmSettingsProposals } from '@vibe/db/schema';

const sqlOne = drizzleSql`SELECT 1`;

import { loadConfig } from './config';
import { logger } from './logger';
import { createStaffAuthRouter, type StaffRoutesDeps } from './auth/staff-routes';
import { staffAuthDeps } from './auth/middleware';
import type { SessionStore } from './auth/session-store';
import type { Database } from '@vibe/db';
import { createAdminRouter } from './admin/routes';
import { createAdminDataRouter } from './admin/data';
import { createPaymentMethodTypeRouter } from './admin/payment-method-types';
import { createTaxJurisdictionRouter, createTaxPaymentTypeRouter } from './admin/tax-catalog';
import { createUnlockRouter, createLockMiddleware } from './admin/unlock';
import { requireStepUpWithLockout } from './auth/step-up-middleware';
import { createEngagementMessagingRouter } from './engagement-messaging/routes';
import { createInternalMessagingRouter } from './internal-messaging/routes';
import { createRequestRouter } from './requests/routes';
import { buildStorageAdapter } from './files/storage';
import { createMessagingRouter } from './messaging/routes';
import { createTemplateRouter } from './admin/templates';
import { createRequestTemplateRouter } from './requests/templates';
import { createTaxonomyRouter } from './taxonomy/routes';
import { createTemplatePackRouter } from './taxonomy/templates';
import { createClientRouter } from './clients/routes';
// internal-files + folder-templates routers removed in Phase 0 of the
// file-manager rebuild. Replacements ship in Phases 4 + 10.
import { createEngagementRouter } from './engagements/routes';
import { createStatusHistoryRouter } from './engagements/status-history';
import { createStatusOptionsRouter } from './engagements/status-options';
import { createStaffFileShareRouter } from './files/share-routes';
import { createEngagementRecurrenceRouter } from './engagements/recurrence';
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
import { createPortalTaxReturnRouter } from './portal/tax-returns';
import { createPortalTaxShareRouter } from './portal/tax-shares';
import { createPortalFileShareRouter } from './portal/file-shares';
import { createSharePublicRouter } from './share-public';
import { createShareRecipientRouter } from './share-public/tax-recipient';
import { createIntakePublicRouter } from './intake/public-routes';
import { createIntakeStaffRouter } from './intake/staff-routes';
import { createIntakeCardRouter } from './intake/card-routes';
import { collectIntakeMetricsText } from './intake/metrics';
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
import { createStorageSettingsRouter } from './admin/storage-settings/routes';
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
import { createHelpRouter } from './help/routes';
import { createApiTokenRouter } from './admin/api-tokens';
import { createCloudflareTunnelRouter } from './admin/cloudflare-tunnel/routes';
import { createAiCredentialsRouter } from './admin/ai-credentials/routes';
import { createStripeWebhookRouter } from './webhooks/stripe';
import { createStripeConnectWebhookRouter } from './webhooks/stripe-connect';
import { createCpaChargeWebhookRouter } from './webhooks/cpacharge';
import { createNotificationWebhookRouter } from './webhooks/notifications';
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
import { createProposalDashboardRouter } from './proposals/dashboard';
import { createPortalMagicLinkRouter, createStaffMagicLinkRouter } from './proposals/magic-links';
import { createSignatureVerifyRouter } from './proposals/signature-verify';
import { createClientAccountRouter } from './proposals/client-accounts';
import { createAcceptanceRouter } from './proposals/acceptance';
import { createSectionViewRouter } from './proposals/section-views';
import { createNativeProvider, createOpenSignProvider, type EsignProvider } from './esign/provider';
import { createOpenSignWebhookRouter } from './webhooks/opensign';
import { createQuickBillRouter } from './quick-bills/routes';
import { createRenewalRouter } from './renewals/routes';
import { createWipRouter } from './wip/routes';
import { createMrrDashboardRouter } from './dashboards/mrr-routes';
import { createCaddyRouter } from './caddy/routes';
import { createTaxReturnRouter } from './tax-returns/routes';
import { createConflictsRouter } from './storage/conflicts';
import { createImpersonationRouter } from './tax-returns/impersonation-routes';
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
  sendEmailOtp?: StaffRoutesDeps['sendEmailOtp'];
  sendSmsOtp?: StaffRoutesDeps['sendSmsOtp'];
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

  // Q35 — OpenSign completion webhook. MUST be mounted before the global
  // express.json() so the raw request bytes survive for HMAC
  // verification (the global parser would otherwise consume the body).
  // Raw-body HMAC (x-webhook-signature) verified against
  // OPENSIGN_WEBHOOK_SECRET; on a `completed` event it fetches+stores the
  // cert in OUR storage (AGPL OpenSign never receives our creds) then
  // advances the proposal under a FOR UPDATE lock (serializes with the
  // worker poll).
  {
    const openSignConfigured = Boolean(config.OPENSIGN_URL);
    let webhookStorage: StorageClient | null = null;
    if (openSignConfigured) {
      try {
        webhookStorage = buildStorageClient(process.env);
      } catch (err) {
        logger.warn({ err }, 'storage client unavailable for opensign webhook');
      }
    }
    app.use(
      '/api/webhooks/opensign',
      createOpenSignWebhookRouter({
        db: deps.db,
        provider:
          openSignConfigured && config.OPENSIGN_URL
            ? createOpenSignProvider({
                baseUrl: config.OPENSIGN_URL,
                appId: config.OPENSIGN_APP_ID,
                masterKey: config.OPENSIGN_MASTER_KEY ?? '',
                publicUrl: config.OPENSIGN_PUBLIC_URL,
                apiEmail: config.OPENSIGN_API_EMAIL,
                apiPassword: config.OPENSIGN_API_PASSWORD,
              })
            : null,
        storage: webhookStorage,
        webhookSecret: config.OPENSIGN_WEBHOOK_SECRET ?? null,
        hmacSeed: config.PROPOSAL_SIGNATURE_HMAC_SEED ?? config.PORTAL_JWT_SECRET ?? null,
        sendProposalEmail: deps.sendStaffMail
          ? (args) =>
              deps.sendStaffMail!({
                to: args.to,
                subject: args.subject,
                body: args.body,
                html: args.html,
              })
          : undefined,
        portalBaseUrl: config.PORTAL_BASE_URL,
      }),
    );
  }

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
      try {
        const intakeLines = await collectIntakeMetricsText(deps.db);
        if (intakeLines) lines.push(intakeLines);
      } catch (err) {
        logger.error({ err }, 'intake metrics collection failed');
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

  // P19 — Caddy on-demand TLS ask endpoint. Mounted BEFORE the lock
  // middleware so cert provisioning keeps working even when the
  // appliance is locked (existing TLS termination shouldn't break
  // mid-incident). No auth: Caddy is a separate process; the route
  // is constrained by a `@internal` host matcher in the Caddy config.
  const caddyRouter = createCaddyRouter({ db: deps.db });
  app.use('/v1/internal', caddyRouter);

  // Stage 1B — lock middleware. Once mounted, every request below this
  // point gets a 503 if the appliance is locked. The middleware
  // allowlist covers /health/*, /metrics, /api/staff/admin/unlock,
  // and /api/auth (so login flows still work).
  app.use(createLockMiddleware());

  const authRouter = createStaffAuthRouter({
    ...deps,
    sendMagicLink: deps.sendMagicLink ?? (async () => undefined),
    sendEmailOtp: deps.sendEmailOtp,
    sendSmsOtp: deps.sendSmsOtp,
    requireAuth: auth.requireAuth,
  });
  app.use('/api/auth', authRouter);

  // Protect everything else under /api/staff/* with requireAuth.
  app.use('/api/staff', auth.requireAuth, auth.requireCsrf);
  app.get('/api/staff/whoami', (req, res) => {
    res.json({ session: req.staffSession });
  });

  const adminRouter = createAdminRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    // Q35 — gate the admin 'opensign' provider option on configuration.
    openSignAvailable: Boolean(config.OPENSIGN_URL),
  });
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

  // 0084 — request templates (sibling to engagement/letter/client
  // templates above; lives under its own subpath to keep the router
  // small + cleanly testable).
  const requestTemplateRouter = createRequestTemplateRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/admin/templates/request',
    auth.requireAuth,
    auth.requireCsrf,
    requestTemplateRouter,
  );

  // 0085 — Cloudflare Tunnel admin provisioning UI.
  const cloudflareTunnelRouter = createCloudflareTunnelRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    commercialLicenseActive: Boolean(config.COMMERCIAL_LICENSE_TOKEN),
    tokenFilePath: process.env['CLOUDFLARED_TOKEN_FILE'] ?? '/run/cloudflared/token',
  });
  app.use(
    '/api/staff/admin/cloudflare-tunnel',
    auth.requireAuth,
    auth.requireCsrf,
    cloudflareTunnelRouter,
  );

  // 0100 — Admin → AI settings: UI-entered AI provider credentials.
  const aiCredentialsRouter = createAiCredentialsRouter({
    db: deps.db,
    redis: deps.redis,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/admin/ai-credentials',
    auth.requireAuth,
    auth.requireCsrf,
    aiCredentialsRouter,
  );

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
    sendStaffMail: deps.sendStaffMail,
  });
  app.use('/api/staff/clients', auth.requireAuth, auth.requireCsrf, clientRouter);

  // 0103 — Document Intake staff inbox + disposition + send-a-link.
  const intakeStaffRouter = createIntakeStaffRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    intakeBaseUrl: process.env['INTAKE_BASE_URL'],
    sendEmail: deps.sendStaffMail
      ? (a) => deps.sendStaffMail!({ to: a.to, subject: a.subject, body: a.body })
      : undefined,
  });
  app.use('/api/staff/intake', auth.requireAuth, auth.requireCsrf, intakeStaffRouter);

  // 0103 — admin intake card settings (visibility/order/title/notify/headshot).
  const intakeCardRouter = createIntakeCardRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/admin/intake', auth.requireAuth, auth.requireCsrf, intakeCardRouter);

  // v1 internal-files + folder-templates routers removed in Phase 0
  // of the file-manager rebuild. Replacements ship in Phases 4 + 10
  // (storage onboarding + per-client UI per FILE_MANAGER_ADDENDUM.md).

  const engagementRouter = createEngagementRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/engagements', auth.requireAuth, auth.requireCsrf, engagementRouter);

  // Firm-wide engagement progress-status change history report. Distinct
  // mount so it never collides with the engagements /:id routes.
  const statusHistoryRouter = createStatusHistoryRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/engagement-status-history',
    auth.requireAuth,
    auth.requireCsrf,
    statusHistoryRouter,
  );

  // Staff-readable progress-status list (for pickers, e.g. logging time).
  const statusOptionsRouter = createStatusOptionsRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/engagement-statuses',
    auth.requireAuth,
    auth.requireCsrf,
    statusOptionsRouter,
  );

  // 0083 — recurring engagements (CRUD + run-now). Worker sweep lives
  // in apps/worker/src/jobs/recurring-engagement.ts.
  const engagementRecurrenceRouter = createEngagementRecurrenceRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/engagement-recurrences',
    auth.requireAuth,
    auth.requireCsrf,
    engagementRecurrenceRouter,
  );

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

  // 0105 — staff-to-staff direct + group messaging.
  const internalMessagingRouter = createInternalMessagingRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/internal-messaging',
    auth.requireAuth,
    auth.requireCsrf,
    internalMessagingRouter,
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
    sendEmail: deps.sendPortalEmail,
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
    sendSms: deps.sendPortalSms,
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
    // TR-5 — same key used by the staff impersonation-routes issuer.
    staffSecret: config.STAFF_JWT_SECRET,
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

  // TR-4 — portal tax-return viewer endpoints.
  const portalTaxReturnRouter = createPortalTaxReturnRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/tax/returns', portalTaxReturnRouter);

  // TR-6 — Portal selective-share API.
  const portalTaxShareRouter = createPortalTaxShareRouter({
    db: deps.db,
    requireAuth: portal.requireAuth,
  });
  app.use('/api/portal/tax/returns', portalTaxShareRouter);

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

  // TR-7 — tax-return recipient page (3rd-party token surface).
  const taxRecipientRouter = createShareRecipientRouter({ db: deps.db });
  app.use('/shared/tax', taxRecipientRouter);

  // 0103/0104 — public anonymous document-intake surface. Mounted outside
  // the staff + portal auth chains (like /api/shared); the intake Caddy
  // site proxies ONLY this prefix. CORS + per-IP rate limit live inside.
  const intakePublicRouter = createIntakePublicRouter({ db: deps.db, redis: deps.redis });
  app.use('/api/public/intake', intakePublicRouter);

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

  // 0096 — support knowledge base (reads open to any staff; kb:manage
  // gates article CRUD inside the router).
  const helpRouter = createHelpRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/help', auth.requireAuth, auth.requireCsrf, helpRouter);

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

  // Destructive data ops — load demo dataset / reset firm to blank.
  // Gated on firm:settings:write + fresh step-up + (for reset) typed
  // confirmation in the body. Mounted here so the shared stepUpGuard
  // (Redis-backed lockout) is in scope.
  const adminDataRouter = createAdminDataRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    requireStepUp: stepUpGuard,
  });
  app.use('/api/staff/admin/data', auth.requireAuth, auth.requireCsrf, adminDataRouter);

  // 0089 — firm-editable payment method catalog. Backs Admin → Catalog
  // → Payment methods and the dropdown on the Receive Payment form.
  const paymentMethodTypeRouter = createPaymentMethodTypeRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/admin/payment-method-types',
    auth.requireAuth,
    auth.requireCsrf,
    paymentMethodTypeRouter,
  );

  // 0090 — Tax jurisdiction + payment-type catalog.
  const taxJurisdictionRouter = createTaxJurisdictionRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/admin/tax-jurisdictions',
    auth.requireAuth,
    auth.requireCsrf,
    taxJurisdictionRouter,
  );
  const taxPaymentTypeRouter = createTaxPaymentTypeRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/admin/tax-payment-types',
    auth.requireAuth,
    auth.requireCsrf,
    taxPaymentTypeRouter,
  );

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

  // 0094 — UI-configurable storage backend (B2 / MinIO / mock).
  // Reads + writes the storage_settings table; secrets are sealed with
  // the firm MFK. Boot reads merged DB-or-env config; admin saves
  // trigger a "restart required" banner in the FE.
  const storageSettingsRouter = createStorageSettingsRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use(
    '/api/staff/admin/storage/settings',
    auth.requireAuth,
    auth.requireCsrf,
    storageSettingsRouter,
  );

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

  // 0102 — staff-initiated secure file sharing (rich third-party links).
  const staffFileShareRouter = createStaffFileShareRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    portalBaseUrl: config.PORTAL_BASE_URL,
    sendEmail: deps.sendStaffMail
      ? (m) => deps.sendStaffMail!({ to: m.to, subject: m.subject, body: m.body })
      : undefined,
    sendSms: deps.sendPortalSms,
  });
  app.use('/api/staff/files', auth.requireAuth, auth.requireCsrf, staffFileShareRouter);

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
    sendEmail: deps.sendPortalEmail,
    sendSms: deps.sendPortalSms,
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

  // P28 — pipeline + conversion dashboard. Mounted under
  // /api/staff/proposals so the GET /dashboard route is reachable as
  // /api/staff/proposals/dashboard.
  const proposalDashboardRouter = createProposalDashboardRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/proposals', auth.requireAuth, auth.requireCsrf, proposalDashboardRouter);

  // P17 — proposal magic-link mint (staff side). Mounted under the
  // same /proposals path so the URL is /proposals/:id/mint-magic-link.
  const staffMagicLinkRouter = createStaffMagicLinkRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    portalBaseUrl: config.PORTAL_BASE_URL,
    // Q34 — best-effort per-signer link delivery. Reuse the staff-mail
    // surface when wired; absence never blocks the signing flow.
    sendProposalEmail: deps.sendStaffMail
      ? (args) =>
          deps.sendStaffMail!({
            to: args.to,
            subject: args.subject,
            body: args.body,
            html: args.html,
          })
      : undefined,
  });
  app.use('/api/staff/proposals', auth.requireAuth, auth.requireCsrf, staffMagicLinkRouter);

  // P17 — proposal magic-link redeem (portal side). No portal-auth
  // middleware — the magic link IS the credential.
  const portalMagicLinkRouter = createPortalMagicLinkRouter({
    db: deps.db,
    redis: deps.redis,
  });
  app.use('/api/portal/proposals', portalMagicLinkRouter);

  // P18 — optional client password accounts. Cookie-based portal
  // session distinct from the existing portal_identity session.
  const clientAccountRouter = createClientAccountRouter({
    db: deps.db,
    redis: deps.redis,
    signingKey: config.PORTAL_JWT_SECRET ?? null,
  });
  app.use('/api/portal/client-accounts', clientAccountRouter);

  // Q35 — per-firm e-sign provider resolution. Native is the default and
  // is used unless the firm's firm_settings_proposals.esign_provider is
  // 'opensign' AND OPENSIGN_URL is configured. If a firm is set to
  // opensign but OPENSIGN_URL is unset we log a warning and fall back to
  // native (non-fatal) — the appliance never breaks the signing flow.
  const nativeEsign = createNativeProvider();
  const openSignConfigured = Boolean(config.OPENSIGN_URL);
  const resolveEsignProvider = async (firmId: string): Promise<EsignProvider> => {
    if (!deps.db) return nativeEsign;
    try {
      const [row] = await deps.db
        .select({ esignProvider: firmSettingsProposals.esignProvider })
        .from(firmSettingsProposals)
        .where(eq(firmSettingsProposals.firmId, firmId))
        .limit(1);
      if (row?.esignProvider === 'opensign') {
        if (!openSignConfigured) {
          logger.warn(
            { firmId },
            'firm set to opensign but OPENSIGN_URL unset — falling back to native',
          );
          return nativeEsign;
        }
        return createOpenSignProvider({
          baseUrl: config.OPENSIGN_URL!,
          appId: config.OPENSIGN_APP_ID,
          masterKey: config.OPENSIGN_MASTER_KEY ?? '',
          publicUrl: config.OPENSIGN_PUBLIC_URL,
          apiEmail: config.OPENSIGN_API_EMAIL,
          apiPassword: config.OPENSIGN_API_PASSWORD,
        });
      }
    } catch (err) {
      logger.warn({ err, firmId }, 'esign provider resolution failed — using native');
    }
    return nativeEsign;
  };

  // P21 — portal acceptance flow. No auth middleware — the route
  // accepts magicLinkId or clientAccountId in the payload so a
  // magic-link-only client (no account) can complete acceptance.
  const acceptanceRouter = createAcceptanceRouter({
    db: deps.db,
    hmacSeed: config.PROPOSAL_SIGNATURE_HMAC_SEED ?? config.PORTAL_JWT_SECRET ?? null,
    resolveEsignProvider,
    portalBaseUrl: config.PORTAL_BASE_URL,
    sendProposalEmail: deps.sendStaffMail
      ? (args) =>
          deps.sendStaffMail!({
            to: args.to,
            subject: args.subject,
            body: args.body,
            html: args.html,
          })
      : undefined,
  });
  app.use('/api/portal/proposals', acceptanceRouter);

  // P20 — per-section view tracking (portal-side, magic-link-gated).
  const sectionViewRouter = createSectionViewRouter({ db: deps.db });
  app.use('/api/portal/proposals', sectionViewRouter);

  // P16 — signature HMAC verification (firm-side).
  const signatureVerifyRouter = createSignatureVerifyRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    hmacSeed: config.PROPOSAL_SIGNATURE_HMAC_SEED ?? config.PORTAL_JWT_SECRET ?? null,
  });
  app.use('/api/staff/signatures', auth.requireAuth, auth.requireCsrf, signatureVerifyRouter);

  // P24 — quick-bill (ad-hoc invoice).
  const quickBillRouter = createQuickBillRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/quick-bills', auth.requireAuth, auth.requireCsrf, quickBillRouter);

  // P25 — renewal engine.
  const renewalRouter = createRenewalRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/renewals', auth.requireAuth, auth.requireCsrf, renewalRouter);

  // P23 — WIP rollup per engagement.
  const wipRouter = createWipRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/wip', auth.requireAuth, auth.requireCsrf, wipRouter);

  // P29 — MRR + cash flow + renewals dashboard.
  const mrrDashboardRouter = createMrrDashboardRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/dashboards', auth.requireAuth, auth.requireCsrf, mrrDashboardRouter);

  // TR-3 — Tax-return staff release API.
  const taxReturnRouter = createTaxReturnRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/tax/returns', auth.requireAuth, auth.requireCsrf, taxReturnRouter);

  // FMv2 §4.6-4.8 — admin folder-conflict resolution.
  const conflictsRouter = createConflictsRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
  });
  app.use('/api/staff/storage/conflicts', auth.requireAuth, auth.requireCsrf, conflictsRouter);

  // TR-5 — Staff view-as-client impersonation.
  const impersonationRouter = createImpersonationRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    staffSecret: config.STAFF_JWT_SECRET,
    portalBaseUrl: config.PORTAL_BASE_URL,
  });
  app.use('/api/staff/clients', auth.requireAuth, auth.requireCsrf, impersonationRouter);

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

  // H.8 follow-up — mail + SMS provider delivery callbacks update
  // notification_log.status. Each provider expects a separate sub-path
  // with a shared-secret token in X-Webhook-Token.
  app.use(
    '/api/webhooks/notifications',
    createNotificationWebhookRouter({
      db: deps.db,
      log: logger,
      postmarkSecret: process.env['NOTIFICATION_WEBHOOK_POSTMARK_SECRET'] ?? null,
      resendSecret: process.env['NOTIFICATION_WEBHOOK_RESEND_SECRET'] ?? null,
      twilioSecret: process.env['NOTIFICATION_WEBHOOK_TWILIO_SECRET'] ?? null,
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
