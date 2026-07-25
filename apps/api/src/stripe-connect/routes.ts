// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P08 — Stripe Connect Standard OAuth staff routes.
//
// Mounted at /api/staff/stripe-connect. The flow is:
//   1. firm staff clicks "Connect Stripe" → POST /authorize-url
//      returns the URL to redirect to + the state token. The state
//      is also stored in Redis with a short TTL so the callback can
//      verify it without sticky sessions.
//   2. Stripe redirects back to the operator-configured redirect URI
//      which lands on the web app, which then POSTs the code +
//      state to /callback.
//   3. /callback exchanges code + state, persists the connected
//      account id onto firm_settings_proposals.
//   4. /account-status refreshes capabilities from
//      https://api.stripe.com/v1/accounts/{id} on demand.
//   5. /disconnect deauthorizes the link.
//
// Test injection: deps.stripeConnect overrides the live network
// calls so tests can mock OAuth without baking in real credentials.

import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { firmSettingsProposals } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import { resolveFirmStripe } from '../payments/firm-stripe';

import {
  buildAuthorizeUrl,
  deauthorize,
  exchangeCode,
  fetchAccount,
  type AccountSummary,
  type ExchangeCodeResult,
} from './oauth';

export interface StripeConnectClient {
  exchangeCode(code: string): Promise<ExchangeCodeResult>;
  deauthorize(stripeUserId: string): Promise<void>;
  fetchAccount(stripeAccountId: string): Promise<AccountSummary>;
}

export interface StripeConnectConfig {
  clientId: string | null;
  secretKey: string | null;
  redirectUri: string | null;
}

export interface StripeConnectRoutesDeps extends RbacDeps {
  db: Database | null;
  redis: Redis | null;
  config: StripeConnectConfig;
  // Test seam: pass a stubbed client to avoid hitting Stripe in tests.
  // Production wiring builds the client from `config`.
  client?: StripeConnectClient;
}

const STATE_PREFIX = 'sc:state:';
const STATE_TTL_SECONDS = 600; // 10 minutes

function buildLiveClient(config: StripeConnectConfig): StripeConnectClient | null {
  if (!config.secretKey || !config.clientId) return null;
  return {
    exchangeCode: (code) => exchangeCode({ secretKey: config.secretKey!, code }),
    deauthorize: (stripeUserId) =>
      deauthorize({
        secretKey: config.secretKey!,
        clientId: config.clientId!,
        stripeUserId,
      }),
    fetchAccount: (stripeAccountId) =>
      fetchAccount({ secretKey: config.secretKey!, stripeAccountId }),
  };
}

const CallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export function createStripeConnectRouter(deps: StripeConnectRoutesDeps): Router {
  const router = express.Router();
  const client = deps.client ?? buildLiveClient(deps.config);

  router.post(
    '/authorize-url',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.config.clientId) {
        res.status(503).json({ error: 'stripe_connect_not_configured' });
        return;
      }
      if (!deps.redis) {
        res.status(503).json({ error: 'redis_unavailable' });
        return;
      }
      const state = `${session.firmId}.${randomBytes(16).toString('hex')}`;
      // Store the state so the callback can confirm the OAuth round-trip
      // landed on the same firm that initiated it.
      await deps.redis.set(`${STATE_PREFIX}${state}`, session.firmId, 'EX', STATE_TTL_SECONDS);
      const url = buildAuthorizeUrl({
        clientId: deps.config.clientId,
        state,
        redirectUri: deps.config.redirectUri ?? undefined,
      });
      res.json({ url, state, expiresInSeconds: STATE_TTL_SECONDS });
    },
  );

  router.post(
    '/callback',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = CallbackSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!client) {
        res.status(503).json({ error: 'stripe_connect_not_configured' });
        return;
      }
      if (!deps.redis) {
        res.status(503).json({ error: 'redis_unavailable' });
        return;
      }
      const stateFirmId = await deps.redis.get(`${STATE_PREFIX}${parsed.data.state}`);
      if (!stateFirmId) {
        res.status(400).json({ error: 'invalid_state' });
        return;
      }
      if (stateFirmId !== session.firmId) {
        res.status(403).json({ error: 'state_firm_mismatch' });
        return;
      }
      await deps.redis.del(`${STATE_PREFIX}${parsed.data.state}`);
      const exchange = await client.exchangeCode(parsed.data.code).catch((err: unknown) => {
        logger.error({ err }, 'stripe oauth exchange failed');
        return null;
      });
      if (!exchange) {
        res.status(502).json({ error: 'stripe_exchange_failed' });
        return;
      }
      const now = new Date();
      // Upsert the firm settings row — the row should already exist
      // after first proposal-module usage but we don't require it.
      const existing = await deps.db
        .select()
        .from(firmSettingsProposals)
        .where(eq(firmSettingsProposals.firmId, session.firmId))
        .limit(1);
      if (existing.length === 0) {
        await deps.db.insert(firmSettingsProposals).values({
          firmId: session.firmId,
          stripeAccountId: exchange.stripeUserId,
          stripePublishableKey: exchange.stripePublishableKey,
          stripeConnectedAt: now,
        });
      } else {
        await deps.db
          .update(firmSettingsProposals)
          .set({
            stripeAccountId: exchange.stripeUserId,
            stripePublishableKey: exchange.stripePublishableKey,
            stripeConnectedAt: now,
            stripeDisconnectedAt: null,
            updatedAt: now,
          })
          .where(eq(firmSettingsProposals.firmId, session.firmId));
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'firm_settings_proposals',
        entityId: session.firmId,
        actorAppUserId: session.appUserId,
        after: {
          stripeAccountId: exchange.stripeUserId,
          livemode: exchange.livemode,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({
        ok: true,
        stripeAccountId: exchange.stripeUserId,
        livemode: exchange.livemode,
      });
    },
  );

  router.post(
    '/disconnect',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!client) {
        res.status(503).json({ error: 'stripe_connect_not_configured' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(firmSettingsProposals)
        .where(eq(firmSettingsProposals.firmId, session.firmId))
        .limit(1);
      if (!row || !row.stripeAccountId) {
        res.status(404).json({ error: 'not_connected' });
        return;
      }
      const stripeAccountId = row.stripeAccountId;
      try {
        await client.deauthorize(stripeAccountId);
      } catch (err) {
        logger.warn({ err }, 'stripe deauthorize failed; clearing local state anyway');
      }
      const now = new Date();
      await deps.db
        .update(firmSettingsProposals)
        .set({
          stripeAccountId: null,
          stripePublishableKey: null,
          stripeAccountCapabilities: {},
          stripeDisconnectedAt: now,
          updatedAt: now,
        })
        .where(eq(firmSettingsProposals.firmId, session.firmId));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'firm_settings_proposals',
        entityId: session.firmId,
        actorAppUserId: session.appUserId,
        before: { stripeAccountId },
        after: { stripeAccountId: null, stripeDisconnectedAt: now.toISOString() },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.get(
    '/account-status',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ connected: false });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(firmSettingsProposals)
        .where(eq(firmSettingsProposals.firmId, session.firmId))
        .limit(1);
      if (!row || !row.stripeAccountId) {
        const firmCreds = await resolveFirmStripe(deps.db, session.firmId);
        res.json({
          connected: false,
          configured: deps.config.clientId != null && deps.config.secretKey != null,
          firmKeyConfigured: firmCreds != null,
        });
        return;
      }
      let liveSummary: AccountSummary | null = null;
      if (client && req.query['refresh'] === 'true') {
        try {
          liveSummary = await client.fetchAccount(row.stripeAccountId);
          // Cache the capabilities so dashboards have something to
          // render without round-tripping every load.
          await deps.db
            .update(firmSettingsProposals)
            .set({
              stripeAccountCapabilities: liveSummary.capabilities,
              updatedAt: new Date(),
            })
            .where(eq(firmSettingsProposals.firmId, session.firmId));
        } catch (err) {
          logger.warn({ err }, 'stripe fetchAccount failed');
        }
      }
      res.json({
        connected: true,
        stripeAccountId: row.stripeAccountId,
        stripePublishableKey: row.stripePublishableKey,
        capabilities: row.stripeAccountCapabilities,
        connectedAt: row.stripeConnectedAt,
        live: liveSummary,
      });
    },
  );

  return router;
}

export { buildLiveClient as liveStripeConnectClient };
