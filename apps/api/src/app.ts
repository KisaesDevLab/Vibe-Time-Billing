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
import { createTaxonomyRouter } from './taxonomy/routes';
import { createClientRouter } from './clients/routes';
import { createEngagementRouter } from './engagements/routes';
import { createTimeEntryRouter } from './time-entries/routes';
import { createPortalAuthRouter, type PortalRoutesDeps } from './auth/portal-routes';
import { portalAuthDeps } from './auth/portal-middleware';
import { createAuditRouter } from './audit/routes';
import { createBillingBatchRouter } from './billing-batches/routes';
import { createAdjustmentRouter } from './adjustments/routes';
import { createReportRouter } from './reports/routes';
import { createInvoiceRouter } from './invoices/routes';
import { createArRouter } from './ar/routes';
import { createApprovalRouter } from './approvals/routes';
import { createPortalInvoiceRouter } from './portal/invoices';
import { createPortalProfileRouter } from './portal/profile';
import { createAdminJobRouter } from './admin/jobs';
import { createStatsRouter } from './stats/routes';
import { createRestV1Router } from './rest-v1/routes';
import { createMcpRouter } from './mcp/routes';
import { createAiRouter } from './ai/routes';
import { createApiTokenRouter } from './admin/api-tokens';
import { createStripeWebhookRouter } from './webhooks/stripe';
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

  const taxonomyRouter = createTaxonomyRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/taxonomy', auth.requireAuth, auth.requireCsrf, taxonomyRouter);

  const clientRouter = createClientRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/clients', auth.requireAuth, auth.requireCsrf, clientRouter);

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
  });
  app.use('/api/staff/billing-batches', auth.requireAuth, auth.requireCsrf, billingBatchRouter);

  const adjustmentRouter = createAdjustmentRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    requireStepUp: auth.requireStepUp,
  });
  app.use('/api/staff/adjustments', auth.requireAuth, auth.requireCsrf, adjustmentRouter);

  const reportRouter = createReportRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/reports', auth.requireAuth, auth.requireCsrf, reportRouter);

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
  const portal = portalAuthDeps(deps.sessionStore);
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
  });
  app.use('/api/portal/profile', portalProfileRouter);

  // REST v1 — token-authenticated integrator surface.
  app.use('/api/v1', createRestV1Router({ db: deps.db }));

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

  const adminJobRouter = createAdminJobRouter({
    db: deps.db,
    fakeUserRoles: deps.fakeUserRoles,
    redisUrl: config.REDIS_URL,
  });
  app.use('/api/staff/admin/jobs', auth.requireAuth, auth.requireCsrf, adminJobRouter);

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

  // Stripe webhook — mounted BEFORE the global JSON body parser would
  // have run, so the raw body is preserved for signature verification.
  // Express routes the call to this router's raw-body parser first.
  app.use(
    '/api/webhooks/stripe',
    createStripeWebhookRouter({
      db: deps.db,
      stripe: deps.stripeProvider ?? null,
      webhookSecret: deps.stripeWebhookSecret ?? null,
    }),
  );

  return app;
}
