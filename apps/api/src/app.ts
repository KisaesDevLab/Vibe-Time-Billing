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
import type { RoleSlug } from '@vibe/core/rbac';

export interface AppDeps {
  db: Database | null;
  redis: Redis;
  sessionStore: SessionStore;
  sendMagicLink?: StaffRoutesDeps['sendMagicLink'];
  sendPortalEmail?: PortalRoutesDeps['sendEmail'];
  sendPortalSms?: PortalRoutesDeps['sendSms'];
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

  return app;
}
