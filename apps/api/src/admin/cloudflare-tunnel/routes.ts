// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Cloudflare Tunnel admin routes — in-app provisioning replaces the
// cloudflared CLI dance documented in ops/docs/install.md Section 6.
//
// Flow:
//   1. UI calls POST /validate with {apiToken, accountId, zoneId}.
//      Server hits Cloudflare to verify all three; returns zoneName.
//   2. UI calls POST /provision with the same + {staffHostname,
//      portalHostname}. Server creates a tunnel + DNS records, pulls
//      the run-token, encrypts both tokens with the firm MFK, and
//      writes the run-token to /run/cloudflared/token (a volume that
//      the sidecar container reads on its entrypoint loop).
//   3. cloudflared connects on its own; the worker periodically polls
//      the local :2000 metrics endpoint and writes a snapshot.
//   4. UI calls GET / to render the current config + status. POST
//      /deprovision deletes the tunnel + DNS records and clears the
//      row.
//
// All secrets at rest are MFK-wrapped (envelopeCodec via the firm key
// manager). Plaintext never lives in the DB.
//
// The portal hostname is always asked at provision time (per the
// locked decision) but its ingress rule is omitted from the tunnel
// configuration unless the appliance has a commercial license token.

import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import {
  createCloudflareClient as defaultCreateCloudflareClient,
  CloudflareApiError,
  type IngressRule,
  type CloudflareClientOptions,
} from '@vibe/core/cloudflare';

type CloudflareClient = ReturnType<typeof defaultCreateCloudflareClient>;
import type { Database } from '@vibe/db';
import { cloudflareTunnelConfigs } from '@vibe/db/schema';

import { emitAudit } from '../../auth/audit';
import { requirePermission, type RbacDeps } from '../../auth/rbac-middleware';
import { getApplianceLockState } from '../../crypto/boot';
import { getFirmKeyManager } from '../../crypto/manager';
import { logger } from '../../logger';

export interface CloudflareTunnelRoutesDeps extends RbacDeps {
  db: Database | null;
  /** Path to the token file the cloudflared sidecar reads. */
  tokenFilePath?: string;
  /** Whether the appliance has a valid commercial license. Controls
   *  whether the portal hostname is registered as an ingress rule. */
  commercialLicenseActive: boolean;
  /** Origin URL the tunnel forwards traffic to (the caddy service inside
   *  the appliance docker network). Defaults to http://caddy:80. */
  originService?: string;
  /** Override the CF client factory (tests inject a mock). */
  createClient?: (opts: CloudflareClientOptions) => CloudflareClient;
}

const FQDN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const HEX_ID_RE = /^[a-f0-9]{32,64}$/i;

const ValidateSchema = z.object({
  apiToken: z.string().min(20).max(200),
  accountId: z.string().regex(HEX_ID_RE),
  zoneId: z.string().regex(HEX_ID_RE),
});

const ProvisionSchema = ValidateSchema.extend({
  staffHostname: z.string().regex(FQDN_RE).max(253),
  portalHostname: z.string().regex(FQDN_RE).max(253).nullable().optional(),
  tunnelName: z.string().min(1).max(120).optional(),
});

function hint(token: string): string {
  return token.length > 4 ? token.slice(-4) : token;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fromBytes(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

export function createCloudflareTunnelRouter(deps: CloudflareTunnelRoutesDeps): Router {
  const router = express.Router();
  const tokenFilePath = deps.tokenFilePath ?? '/run/cloudflared/token';
  const originService = deps.originService ?? 'http://caddy:80';
  const createCloudflareClient = deps.createClient ?? defaultCreateCloudflareClient;

  // ---------------------------------------------------------------------
  // GET / — current config + last status snapshot. Secrets redacted.
  // ---------------------------------------------------------------------
  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ config: null });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(cloudflareTunnelConfigs)
        .where(eq(cloudflareTunnelConfigs.firmId, session.firmId))
        .limit(1);
      if (!row) {
        res.json({ config: null });
        return;
      }
      res.json({
        config: {
          id: row.id,
          accountId: row.accountId,
          zoneId: row.zoneId,
          zoneName: row.zoneName,
          staffHostname: row.staffHostname,
          portalHostname: row.portalHostname,
          tunnelId: row.tunnelId,
          tunnelName: row.tunnelName,
          apiTokenHint: row.apiTokenHint,
          status: row.status,
          lastError: row.lastError,
          lastProvisionedAt: row.lastProvisionedAt,
          lastStatusCheckAt: row.lastStatusCheckAt,
          metricsSnapshot: row.metricsSnapshot,
        },
      });
    },
  );

  // ---------------------------------------------------------------------
  // POST /validate — verifies the API token has access to the named
  // account + zone. Used by the UI Step 1 to gate progress to Step 2.
  // ---------------------------------------------------------------------
  router.post(
    '/validate',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = ValidateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const client = createCloudflareClient({ apiToken: parsed.data.apiToken });

      try {
        await client.validateApiToken(parsed.data.accountId);
        const zone = await client.getZone(parsed.data.zoneId);
        res.json({
          ok: true,
          zoneName: zone.name,
          zoneStatus: zone.status,
        });
      } catch (err) {
        if (err instanceof CloudflareApiError) {
          res
            .status(400)
            .json({ error: 'cloudflare_rejected', errors: err.errors, status: err.status });
          return;
        }
        logger.warn({ err }, 'cf tunnel validate failed');
        res.status(502).json({ error: 'cloudflare_unreachable' });
      }
    },
  );

  // ---------------------------------------------------------------------
  // POST /provision — creates the tunnel, pulls the run-token, writes
  // DNS records, sets ingress, encrypts tokens, writes the run-token
  // to the sidecar volume, stamps the row to ACTIVE.
  //
  // Reusable for re-provision: an existing row gets its tunnel deleted
  // and recreated (the user might be moving zones or rotating creds).
  // ---------------------------------------------------------------------
  router.post(
    '/provision',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const lockState = getApplianceLockState();
      if (lockState.kind !== 'unlocked') {
        res.status(503).json({ error: 'appliance_locked', state: lockState.kind });
        return;
      }
      const parsed = ProvisionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const d = parsed.data;

      // Mark PROVISIONING so concurrent provision attempts get an early
      // 409. Upsert via firm-unique index.
      await deps.db
        .insert(cloudflareTunnelConfigs)
        .values({
          firmId: session.firmId,
          status: 'PROVISIONING',
          accountId: d.accountId,
          zoneId: d.zoneId,
          staffHostname: d.staffHostname,
          portalHostname: d.portalHostname ?? null,
          tunnelName: d.tunnelName ?? 'vibe-tb',
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: cloudflareTunnelConfigs.firmId,
          set: {
            status: 'PROVISIONING',
            accountId: d.accountId,
            zoneId: d.zoneId,
            staffHostname: d.staffHostname,
            portalHostname: d.portalHostname ?? null,
            tunnelName: d.tunnelName ?? 'vibe-tb',
            lastError: null,
            updatedAt: new Date(),
          },
        });

      const cf = createCloudflareClient({ apiToken: d.apiToken });
      try {
        // Verify zone + account again (in case validate was skipped).
        await cf.validateApiToken(d.accountId);
        const zone = await cf.getZone(d.zoneId);

        // If we already had a tunnel for this firm, delete it first so
        // re-provision starts clean (also removes its DNS records on
        // Cloudflare's side via cascade where supported).
        const [existing] = await deps.db
          .select({ tunnelId: cloudflareTunnelConfigs.tunnelId })
          .from(cloudflareTunnelConfigs)
          .where(eq(cloudflareTunnelConfigs.firmId, session.firmId))
          .limit(1);
        if (existing?.tunnelId) {
          try {
            await cf.deleteTunnel(d.accountId, existing.tunnelId);
          } catch (err) {
            // Non-fatal: the old tunnel may already be gone.
            logger.warn({ err }, 'cf tunnel: prior tunnel delete failed (continuing)');
          }
        }

        const tunnel = await cf.createTunnel(d.accountId, d.tunnelName ?? 'vibe-tb');
        const runToken = await cf.getTunnelToken(d.accountId, tunnel.id);

        // Ingress rules. Portal rule only registered when licensed.
        const ingress: IngressRule[] = [
          {
            hostname: d.staffHostname,
            service: originService,
            originRequest: {
              httpHostHeader: d.staffHostname,
              noTLSVerify: true,
              connectTimeout: '30s',
            },
          },
        ];
        if (d.portalHostname && deps.commercialLicenseActive) {
          ingress.push({
            hostname: d.portalHostname,
            service: originService,
            originRequest: {
              httpHostHeader: d.portalHostname,
              noTLSVerify: true,
              connectTimeout: '30s',
            },
          });
        }
        ingress.push({ service: 'http_status:404' });
        await cf.setTunnelIngress(d.accountId, tunnel.id, { ingress });

        // DNS CNAMEs → <tunnel>.cfargotunnel.com (Cloudflare's standard
        // tunnel target).
        const cnameTarget = `${tunnel.id}.cfargotunnel.com`;
        await cf.upsertCnameRecord(d.zoneId, d.staffHostname, cnameTarget);
        if (d.portalHostname && deps.commercialLicenseActive) {
          await cf.upsertCnameRecord(d.zoneId, d.portalHostname, cnameTarget);
        }

        // Encrypt + write the sidecar token file.
        const keyMgr = getFirmKeyManager(deps.db);
        const apiTokenEnc = keyMgr.wrapTDek(session.firmId, utf8(d.apiToken));
        const tunnelTokenEnc = keyMgr.wrapTDek(session.firmId, utf8(runToken));

        try {
          await mkdir(dirname(tokenFilePath), { recursive: true });
          await writeFile(tokenFilePath, runToken, { mode: 0o600 });
        } catch (err) {
          // If we can't write the token file the sidecar won't connect,
          // but we still persist the DB row so the operator can rerun.
          logger.error({ err, tokenFilePath }, 'cf tunnel: token file write failed');
        }

        await deps.db
          .update(cloudflareTunnelConfigs)
          .set({
            zoneName: zone.name,
            tunnelId: tunnel.id,
            tunnelName: tunnel.name,
            apiTokenEncrypted: apiTokenEnc,
            apiTokenHint: hint(d.apiToken),
            tunnelTokenEncrypted: tunnelTokenEnc,
            status: 'ACTIVE',
            lastError: null,
            lastProvisionedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(cloudflareTunnelConfigs.firmId, session.firmId));

        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'cloudflare_tunnel_config',
          entityId: tunnel.id,
          actorAppUserId: session.appUserId,
          after: {
            tunnelId: tunnel.id,
            staffHostname: d.staffHostname,
            portalHostname: d.portalHostname,
            ingressCount: ingress.length,
          },
        }).catch(() => undefined);

        res.json({
          ok: true,
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
          zoneName: zone.name,
          ingressCount: ingress.length,
          portalIngressActive: ingress.length > 2,
        });
      } catch (err) {
        const message =
          err instanceof CloudflareApiError
            ? (err.errors[0]?.message ?? `HTTP ${err.status}`)
            : err instanceof Error
              ? err.message
              : 'unknown';
        await deps.db
          .update(cloudflareTunnelConfigs)
          .set({ status: 'ERROR', lastError: message, updatedAt: new Date() })
          .where(eq(cloudflareTunnelConfigs.firmId, session.firmId));
        logger.error({ err }, 'cf tunnel provision failed');
        res.status(502).json({ error: 'provision_failed', message });
      }
    },
  );

  // ---------------------------------------------------------------------
  // POST /deprovision — delete the tunnel + DNS records, clear the row.
  // ---------------------------------------------------------------------
  router.post(
    '/deprovision',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const lockState = getApplianceLockState();
      if (lockState.kind !== 'unlocked') {
        res.status(503).json({ error: 'appliance_locked', state: lockState.kind });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(cloudflareTunnelConfigs)
        .where(eq(cloudflareTunnelConfigs.firmId, session.firmId))
        .limit(1);
      if (!row || !row.tunnelId || !row.apiTokenEncrypted) {
        res.status(404).json({ error: 'no_tunnel' });
        return;
      }
      const keyMgr = getFirmKeyManager(deps.db);
      const apiToken = fromBytes(keyMgr.unwrapTDek(session.firmId, row.apiTokenEncrypted));
      const cf = createCloudflareClient({ apiToken });
      const errors: string[] = [];

      // Clean up DNS records first so a downstream tunnel-delete failure
      // doesn't leave dangling DNS pointing at a deleted tunnel.
      if (row.zoneId && row.staffHostname) {
        try {
          const rec = await cf.findDnsRecord(row.zoneId, row.staffHostname);
          if (rec) await cf.deleteDnsRecord(row.zoneId, rec.id);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : 'staff_dns');
        }
      }
      if (row.zoneId && row.portalHostname) {
        try {
          const rec = await cf.findDnsRecord(row.zoneId, row.portalHostname);
          if (rec) await cf.deleteDnsRecord(row.zoneId, rec.id);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : 'portal_dns');
        }
      }
      if (row.accountId) {
        try {
          await cf.deleteTunnel(row.accountId, row.tunnelId);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : 'tunnel');
        }
      }

      // Clear sidecar token so it stops connecting on next restart.
      try {
        await unlink(tokenFilePath);
      } catch {
        // file may not exist — fine.
      }

      await deps.db
        .update(cloudflareTunnelConfigs)
        .set({
          status: 'INACTIVE',
          tunnelId: null,
          tunnelName: null,
          tunnelTokenEncrypted: null,
          apiTokenEncrypted: null,
          apiTokenHint: null,
          lastError: errors.length > 0 ? errors.join('; ') : null,
          metricsSnapshot: null,
          updatedAt: new Date(),
        })
        .where(eq(cloudflareTunnelConfigs.firmId, session.firmId));

      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'cloudflare_tunnel_config',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { tunnelId: row.tunnelId, errors },
      }).catch(() => undefined);

      res.json({ ok: true, errors });
    },
  );

  // ---------------------------------------------------------------------
  // GET /status — fresh probe of the cloudflared sidecar's :2000
  // endpoint. The worker writes the same snapshot to metricsSnapshot
  // on a 60s cadence; this endpoint serves the cached value plus an
  // on-demand refresh hint for the UI.
  // ---------------------------------------------------------------------
  router.get(
    '/status',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ snapshot: null });
        return;
      }
      const [row] = await deps.db
        .select({
          status: cloudflareTunnelConfigs.status,
          lastError: cloudflareTunnelConfigs.lastError,
          lastStatusCheckAt: cloudflareTunnelConfigs.lastStatusCheckAt,
          metricsSnapshot: cloudflareTunnelConfigs.metricsSnapshot,
        })
        .from(cloudflareTunnelConfigs)
        .where(eq(cloudflareTunnelConfigs.firmId, session.firmId))
        .limit(1);
      res.json({
        status: row?.status ?? 'INACTIVE',
        lastError: row?.lastError ?? null,
        lastStatusCheckAt: row?.lastStatusCheckAt ?? null,
        snapshot: row?.metricsSnapshot ?? null,
      });
    },
  );

  return router;
}
