// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P19 — Caddy on-demand TLS support.
//
// GET /v1/internal/caddy-ask?domain=acme.example.com
//   200 — domain is registered + DNS-verified for a firm; Caddy may
//         provision a Let's Encrypt cert.
//   403 — domain is unknown or not yet verified; Caddy must refuse.
//
// This endpoint is unauthenticated by design (Caddy is a separate
// process and can't carry session cookies), but it is rate-limited
// per source IP and constrained to LAN traffic by a Caddy
// `@internal` host matcher in the ingress config. The endpoint never
// returns information beyond the boolean — no firm id, no name, no
// telemetry leak.
//
// The `domain` query param is normalized to lower-case and
// validated against a strict hostname regex before the DB lookup.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { firmSettingsProposals } from '@vibe/db/schema';

import { logger } from '../logger';

export interface CaddyAskDeps {
  db: Database | null;
}

// RFC 1035-compatible hostname. We intentionally do not accept raw
// IPs — Caddy already filters those out, and we don't want to issue
// certs for IP-only requests.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const Schema = z.object({
  domain: z.string().min(1).max(253),
});

export function createCaddyRouter(deps: CaddyAskDeps): Router {
  const router = express.Router();

  router.get('/caddy-ask', async (req: Request, res: Response) => {
    const parsed = Schema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const normalized = parsed.data.domain.trim().toLowerCase();
    if (!HOSTNAME_RE.test(normalized)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!deps.db) {
      // Fail closed when DB is unavailable. Caddy will refuse the
      // cert; ops investigates.
      logger.warn({ domain: normalized }, 'caddy-ask: db unavailable, refusing');
      res.status(503).json({ error: 'unavailable' });
      return;
    }
    const [row] = await deps.db
      .select({ firmId: firmSettingsProposals.firmId })
      .from(firmSettingsProposals)
      .where(
        and(
          eq(firmSettingsProposals.customDomain, normalized),
          isNotNull(firmSettingsProposals.customDomainVerifiedAt),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    // Caddy treats any 2xx as "yes". The body is for debugging only.
    res.status(200).json({ ok: true });
  });

  return router;
}
