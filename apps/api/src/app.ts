// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import express, { type Express, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import type { Redis } from 'ioredis';

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
import { createRestV1Router } from './rest-v1/routes';
import { createMcpRouter } from './mcp/routes';
import { createAiRouter } from './ai/routes';
import type { AiProvider } from '@vibe/core/ai';
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
  fakeUserRoles?: Map<string, RoleSlug[]>;
}

export function createApp(deps: AppDeps): Express {
  const config = loadConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'vibe-time-billing-api',
      env: config.NODE_ENV,
      portalEnabled: Boolean(config.COMMERCIAL_LICENSE_TOKEN),
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

  const invoiceRouter = createInvoiceRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  app.use('/api/staff/invoices', auth.requireAuth, auth.requireCsrf, invoiceRouter);

  const arRouter = createArRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles });
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

  return app;
}
