// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Vibe Connect interface (Phase 24). Connect is a future Kisaes-hosted
// event-routing layer that lets firms wire one webhook destination and
// have it fan out to multiple consumers (e.g. Slack, Notion, Linear,
// custom AI agents). This module exposes the firm-side wire shape so
// the appliance can opt-in when Connect ships. Until then, endpoints
// return a 503 with `not_configured`.

import express, { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface ConnectRoutesDeps extends RbacDeps {
  db: Database | null;
  connectBaseUrl?: string | null;
  connectApiKey?: string | null;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createConnectRouter(deps: ConnectRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/status',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (_req: Request, res: Response) => {
      const configured = Boolean(deps.connectBaseUrl && deps.connectApiKey);
      res.json({
        configured,
        baseUrl: deps.connectBaseUrl ?? null,
        note: configured
          ? 'Connect is wired; events flow to the upstream router.'
          : 'Connect is not configured. Set VIBE_CONNECT_BASE_URL + VIBE_CONNECT_API_KEY in env.',
      });
    },
  );

  // Future endpoints — placeholders so the staff UI can be wired now and
  // start working the moment Connect ships:
  //   POST /enroll           → bind this appliance to a Connect tenant
  //   POST /subscriptions    → manage event subscriptions remotely
  //   GET  /destinations     → list configured Slack/Notion/Linear sinks
  //   POST /events/dry-run   → test a payload against subscriptions
  router.post(
    '/enroll',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      if (!deps.connectBaseUrl || !deps.connectApiKey) {
        res.status(503).json({ error: 'not_configured' });
        return;
      }
      const session = req.staffSession!;
      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      try {
        const r = await fetchImpl(`${deps.connectBaseUrl.replace(/\/$/, '')}/enroll`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${deps.connectApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            firmId: session.firmId,
            appUserId: session.appUserId,
            audience: 'time-billing',
          }),
        });
        // Upstream may return JSON or a bare body; tolerate both. Mirror
        // the upstream status so the staff UI sees the truth.
        let body: unknown;
        try {
          body = await r.json();
        } catch {
          body = { ok: r.ok };
        }
        res.status(r.status).json(body);
      } catch (err) {
        logger.warn({ err, firmId: session.firmId }, 'connect enroll upstream call failed');
        res.status(502).json({ error: 'upstream_unreachable' });
      }
    },
  );

  return router;
}
