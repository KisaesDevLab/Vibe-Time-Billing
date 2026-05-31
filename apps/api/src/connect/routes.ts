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

  // Future endpoints — placeholders so the staff UI can be wired now
  // and start working the moment Connect ships. All four follow the
  // same pattern: proxy to upstream with the firm's bearer token, mirror
  // the upstream status, fall closed with 503 when unconfigured.
  router.post(
    '/enroll',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      await proxyUpstream(deps, res, 'POST', '/enroll', {
        firmId: session.firmId,
        appUserId: session.appUserId,
        audience: 'time-billing',
      });
    },
  );

  // Subscriptions live on the Connect tenant; the appliance only
  // forwards the firm-side body verbatim. UI is expected to pre-shape
  // the payload (subscription_id, event_types, destination_id, etc.).
  router.post(
    '/subscriptions',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      await proxyUpstream(deps, res, 'POST', '/subscriptions', {
        firmId: session.firmId,
        body: req.body,
      });
    },
  );

  // Read-only — lists destination sinks the firm has registered with
  // Connect (Slack/Notion/Linear/etc). The token in deps.connectApiKey
  // is firm-scoped on the upstream side.
  router.get(
    '/destinations',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      // Pass firmId as a query parameter so the upstream can scope.
      await proxyUpstream(
        deps,
        res,
        'GET',
        `/destinations?firmId=${encodeURIComponent(session.firmId)}`,
        null,
      );
    },
  );

  // Dry-run a payload against the firm's current subscription routing.
  // Useful from the staff UI to verify a sink configuration without
  // having to trigger a real event.
  router.post(
    '/events/dry-run',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      await proxyUpstream(deps, res, 'POST', '/events/dry-run', {
        firmId: session.firmId,
        payload: req.body,
      });
    },
  );

  return router;
}

async function proxyUpstream(
  deps: ConnectRoutesDeps,
  res: Response,
  method: 'GET' | 'POST',
  upstreamPath: string,
  body: unknown,
): Promise<void> {
  if (!deps.connectBaseUrl || !deps.connectApiKey) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const url = `${deps.connectBaseUrl.replace(/\/$/, '')}${upstreamPath}`;
  try {
    const r = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${deps.connectApiKey}`,
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
    });
    // Upstream may return JSON or a bare body; tolerate both. Mirror
    // upstream status so the staff UI sees the truth.
    let respBody: unknown;
    try {
      respBody = await r.json();
    } catch {
      respBody = { ok: r.ok };
    }
    res.status(r.status).json(respBody);
  } catch (err) {
    logger.warn({ err, path: upstreamPath }, 'connect proxy upstream call failed');
    res.status(502).json({ error: 'upstream_unreachable' });
  }
}
