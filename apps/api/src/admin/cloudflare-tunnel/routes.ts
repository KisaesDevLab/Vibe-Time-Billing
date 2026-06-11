// SPDX-License-Identifier: Elastic-2.0
//
// Cloudflare Tunnel admin routes — in-app provisioning replaces the
// cloudflared CLI dance documented in ops/docs/install.md Section 6.
//
// Flow:
//   1. UI calls POST /discover with {apiToken}. Server validates the
//      token and returns the accounts + zones it can see so the wizard
//      can offer dropdowns instead of raw 32-char IDs.
//   2. UI calls POST /provision with {apiToken, accountId, zoneId,
//      hostnames:[{hostname,realm}]}. Server creates a tunnel + DNS
//      records, sets ingress, pulls the run-token, encrypts both tokens
//      with the firm MFK, and writes the run-token to the sidecar
//      volume.
//   3. cloudflared connects on its own; the worker periodically polls
//      the local :2000 metrics endpoint and writes a snapshot.
//   4. UI calls GET / to render the current config + hostname list +
//      status. POST /update edits the hostname list in place (reconciles
//      ingress + DNS without recreating the tunnel). POST /deprovision
//      deletes the tunnel + all DNS records and clears the row.
//
// Realm routing: each hostname is tagged STAFF, PORTAL, or ESIGN. STAFF
// and PORTAL rules rewrite the origin Host header
// (originRequest.httpHostHeader) to a realm-canonical host — portal.<zone>
// for PORTAL, app.<zone> for STAFF — so Caddy's existing
// `@portal host portal.*` matcher routes the request into the right realm
// regardless of the public hostname label. ESIGN rules instead route to
// the OpenSign sidecar (opensign-caddy:4001) with NO Host rewrite, since
// that Caddy serves a host-agnostic plain-HTTP site. No Caddyfile change
// required for any realm.
//
// All secrets at rest are MFK-wrapped (via the firm key manager).
// Plaintext never lives in the DB. PORTAL hostnames are always saved but
// their ingress + DNS are skipped unless the appliance has a commercial
// license token (re-license picks them up on the next provision/update).

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
import { cloudflareTunnelConfigs, cloudflareTunnelHostnames } from '@vibe/db/schema';

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
   *  whether PORTAL hostnames are registered as ingress rules + DNS. */
  commercialLicenseActive: boolean;
  /** Origin URL the tunnel forwards traffic to (the caddy service inside
   *  the appliance docker network). Defaults to http://caddy:80. */
  originService?: string;
  /** Origin URL for ESIGN-realm hostnames — the OpenSign sidecar's Caddy,
   *  reached over the shared opensign-net bridge. Host-agnostic plain HTTP
   *  (Cloudflare terminates TLS at the edge). Defaults to
   *  http://opensign-caddy:4001. */
  esignOriginService?: string;
  /** Override the CF client factory (tests inject a mock). */
  createClient?: (opts: CloudflareClientOptions) => CloudflareClient;
}

const FQDN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const HEX_ID_RE = /^[a-f0-9]{32,64}$/i;

type Realm = 'STAFF' | 'PORTAL' | 'ESIGN' | 'INTAKE';
interface HostnameSpec {
  hostname: string;
  realm: Realm;
}

const HostnameSchema = z.object({
  hostname: z.string().regex(FQDN_RE).max(253),
  realm: z.enum(['STAFF', 'PORTAL', 'ESIGN', 'INTAKE']),
});

const DiscoverSchema = z.object({
  apiToken: z.string().min(20).max(200),
});

const ValidateSchema = z.object({
  apiToken: z.string().min(20).max(200),
  accountId: z.string().regex(HEX_ID_RE),
  zoneId: z.string().regex(HEX_ID_RE),
});

// Provision accepts the new hostnames[] list. Legacy
// staffHostname/portalHostname fields remain accepted (normalized into
// the list) so older callers + existing tests keep working.
const ProvisionSchema = ValidateSchema.extend({
  hostnames: z.array(HostnameSchema).min(1).max(50).optional(),
  staffHostname: z.string().regex(FQDN_RE).max(253).optional(),
  portalHostname: z.string().regex(FQDN_RE).max(253).nullable().optional(),
  tunnelName: z.string().min(1).max(120).optional(),
});

// Edit-in-place: reuses the stored API token + account/zone; only the
// hostname list changes.
const UpdateSchema = z.object({
  hostnames: z.array(HostnameSchema).min(1).max(50),
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

// Normalize a provision payload into a deduped hostname list. Prefers the
// explicit hostnames[] array; falls back to the legacy staff/portal pair.
function normalizeHostnames(d: {
  hostnames?: HostnameSpec[];
  staffHostname?: string;
  portalHostname?: string | null;
}): HostnameSpec[] {
  const out: HostnameSpec[] = [];
  const seen = new Set<string>();
  const push = (hostname: string, realm: Realm): void => {
    const key = hostname.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ hostname, realm });
  };
  if (d.hostnames && d.hostnames.length > 0) {
    for (const h of d.hostnames) push(h.hostname, h.realm);
  } else {
    if (d.staffHostname) push(d.staffHostname, 'STAFF');
    if (d.portalHostname) push(d.portalHostname, 'PORTAL');
  }
  return out;
}

// Build the tunnel ingress from a hostname list. Each rule rewrites the
// origin Host header to a realm-canonical value so Caddy routes it into
// the right realm. PORTAL rules are omitted unless licensed. A trailing
// catch-all 404 is always appended (Cloudflare requires it).
function buildIngress(
  hostnames: HostnameSpec[],
  zoneName: string,
  licensed: boolean,
  originService: string,
  esignOriginService: string,
): IngressRule[] {
  const ingress: IngressRule[] = [];
  for (const h of hostnames) {
    // PORTAL + INTAKE are commercial-licensed surfaces — skip their ingress
    // (and DNS) on an unlicensed appliance.
    if ((h.realm === 'PORTAL' || h.realm === 'INTAKE') && !licensed) continue;
    // ESIGN routes to the OpenSign sidecar with NO Host-header rewrite —
    // its Caddy serves a host-agnostic plain-HTTP site on :4001.
    if (h.realm === 'ESIGN') {
      ingress.push({
        hostname: h.hostname,
        service: esignOriginService,
        originRequest: { connectTimeout: 30 },
      });
      continue;
    }
    const canonicalHost =
      h.realm === 'PORTAL'
        ? `portal.${zoneName}`
        : h.realm === 'INTAKE'
          ? `intake.${zoneName}`
          : `app.${zoneName}`;
    ingress.push({
      hostname: h.hostname,
      service: originService,
      originRequest: {
        httpHostHeader: canonicalHost,
        noTLSVerify: true,
        connectTimeout: 30,
      },
    });
  }
  ingress.push({ service: 'http_status:404' });
  return ingress;
}

function firstOfRealm(hostnames: HostnameSpec[], realm: Realm): string | null {
  return hostnames.find((h) => h.realm === realm)?.hostname ?? null;
}

export function createCloudflareTunnelRouter(deps: CloudflareTunnelRoutesDeps): Router {
  const router = express.Router();
  const tokenFilePath = deps.tokenFilePath ?? '/run/cloudflared/token';
  const originService = deps.originService ?? 'http://caddy:80';
  const esignOriginService = deps.esignOriginService ?? 'http://opensign-caddy:4001';
  const createCloudflareClient = deps.createClient ?? defaultCreateCloudflareClient;

  // Persist the hostname list for a firm: replace the child rows and keep
  // the legacy staff/portal columns pointed at the first of each realm.
  async function persistHostnames(
    db: Database,
    firmId: string,
    rows: Array<HostnameSpec & { dnsRecordId: string | null }>,
  ): Promise<void> {
    await db.delete(cloudflareTunnelHostnames).where(eq(cloudflareTunnelHostnames.firmId, firmId));
    if (rows.length > 0) {
      await db.insert(cloudflareTunnelHostnames).values(
        rows.map((r) => ({
          firmId,
          hostname: r.hostname,
          realm: r.realm,
          dnsRecordId: r.dnsRecordId,
          updatedAt: new Date(),
        })),
      );
    }
  }

  async function loadHostnames(db: Database, firmId: string): Promise<HostnameSpec[]> {
    const rows = await db
      .select({
        hostname: cloudflareTunnelHostnames.hostname,
        realm: cloudflareTunnelHostnames.realm,
      })
      .from(cloudflareTunnelHostnames)
      .where(eq(cloudflareTunnelHostnames.firmId, firmId));
    return rows.map((r) => ({ hostname: r.hostname, realm: r.realm as Realm }));
  }

  // ---------------------------------------------------------------------
  // GET / — current config + hostname list + last status snapshot.
  // Secrets redacted.
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
      const hostnames = await loadHostnames(deps.db, session.firmId);
      res.json({
        config: {
          id: row.id,
          accountId: row.accountId,
          zoneId: row.zoneId,
          zoneName: row.zoneName,
          staffHostname: row.staffHostname,
          portalHostname: row.portalHostname,
          hostnames,
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
  // POST /discover — validate the token and list the accounts + zones it
  // can see, so the UI can render dropdowns. No DB writes.
  // ---------------------------------------------------------------------
  router.post(
    '/discover',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = DiscoverSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const client = createCloudflareClient({ apiToken: parsed.data.apiToken });
      try {
        const [accounts, zones] = await Promise.all([client.listAccounts(), client.listZones()]);
        res.json({ ok: true, accounts, zones });
      } catch (err) {
        if (err instanceof CloudflareApiError) {
          res
            .status(400)
            .json({ error: 'cloudflare_rejected', errors: err.errors, status: err.status });
          return;
        }
        logger.warn({ err }, 'cf tunnel discover failed');
        res.status(502).json({ error: 'cloudflare_unreachable' });
      }
    },
  );

  // ---------------------------------------------------------------------
  // POST /validate — verifies the API token has access to the named
  // account + zone. Retained for back-compat; /discover supersedes it.
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
        res.json({ ok: true, zoneName: zone.name, zoneStatus: zone.status });
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
  // DNS records for every hostname, sets ingress, encrypts tokens, writes
  // the run-token to the sidecar volume, stamps the row to ACTIVE.
  //
  // Reusable for re-provision: an existing tunnel is deleted and
  // recreated (the user might be moving zones or rotating creds).
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
      const hostnames = normalizeHostnames(d);
      if (hostnames.length === 0) {
        res.status(400).json({ error: 'no_hostnames' });
        return;
      }
      const staffHostname = firstOfRealm(hostnames, 'STAFF');
      const portalHostname = firstOfRealm(hostnames, 'PORTAL');

      // Mark PROVISIONING so concurrent provision attempts get an early
      // 409. Upsert via firm-unique index.
      await deps.db
        .insert(cloudflareTunnelConfigs)
        .values({
          firmId: session.firmId,
          status: 'PROVISIONING',
          accountId: d.accountId,
          zoneId: d.zoneId,
          staffHostname,
          portalHostname,
          tunnelName: d.tunnelName ?? 'vibe-tb',
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: cloudflareTunnelConfigs.firmId,
          set: {
            status: 'PROVISIONING',
            accountId: d.accountId,
            zoneId: d.zoneId,
            staffHostname,
            portalHostname,
            tunnelName: d.tunnelName ?? 'vibe-tb',
            lastError: null,
            updatedAt: new Date(),
          },
        });

      const cf = createCloudflareClient({ apiToken: d.apiToken });
      try {
        // Verify zone + account again (in case discover/validate skipped).
        await cf.validateApiToken(d.accountId);
        const zone = await cf.getZone(d.zoneId);

        // Delete any prior tunnel so re-provision starts clean.
        const [existing] = await deps.db
          .select({ tunnelId: cloudflareTunnelConfigs.tunnelId })
          .from(cloudflareTunnelConfigs)
          .where(eq(cloudflareTunnelConfigs.firmId, session.firmId))
          .limit(1);
        if (existing?.tunnelId) {
          try {
            await cf.deleteTunnel(d.accountId, existing.tunnelId);
          } catch (err) {
            logger.warn({ err }, 'cf tunnel: prior tunnel delete failed (continuing)');
          }
        }

        // Also clean up any orphan tunnel of the same name left by a prior
        // failed provision (its id never made it into the DB), so create
        // doesn't fail with "tunnel with this name already exists" (1013).
        const tunnelName = d.tunnelName ?? 'vibe-tb';
        try {
          const orphan = await cf.findTunnelByName(d.accountId, tunnelName);
          if (orphan && orphan.id !== existing?.tunnelId) {
            await cf.deleteTunnel(d.accountId, orphan.id);
          }
        } catch (err) {
          logger.warn({ err }, 'cf tunnel: orphan tunnel cleanup failed (continuing)');
        }

        const tunnel = await cf.createTunnel(d.accountId, tunnelName);
        const runToken = await cf.getTunnelToken(d.accountId, tunnel.id);

        const ingress = buildIngress(
          hostnames,
          zone.name,
          deps.commercialLicenseActive,
          originService,
          esignOriginService,
        );
        await cf.setTunnelIngress(d.accountId, tunnel.id, { ingress });

        // DNS CNAMEs → <tunnel>.cfargotunnel.com. PORTAL + INTAKE hostnames
        // are recorded but get no DNS until licensed.
        const cnameTarget = `${tunnel.id}.cfargotunnel.com`;
        const persisted: Array<HostnameSpec & { dnsRecordId: string | null }> = [];
        for (const h of hostnames) {
          if ((h.realm === 'PORTAL' || h.realm === 'INTAKE') && !deps.commercialLicenseActive) {
            persisted.push({ ...h, dnsRecordId: null });
            continue;
          }
          const rec = await cf.upsertCnameRecord(d.zoneId, h.hostname, cnameTarget);
          persisted.push({ hostname: h.hostname, realm: h.realm, dnsRecordId: rec.id });
        }

        // Encrypt + write the sidecar token file.
        const keyMgr = getFirmKeyManager(deps.db);
        const apiTokenEnc = keyMgr.wrapTDek(session.firmId, utf8(d.apiToken));
        const tunnelTokenEnc = keyMgr.wrapTDek(session.firmId, utf8(runToken));

        try {
          await mkdir(dirname(tokenFilePath), { recursive: true });
          await writeFile(tokenFilePath, runToken, { mode: 0o600 });
        } catch (err) {
          logger.error({ err, tokenFilePath }, 'cf tunnel: token file write failed');
        }

        await deps.db
          .update(cloudflareTunnelConfigs)
          .set({
            zoneName: zone.name,
            staffHostname,
            portalHostname,
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

        await persistHostnames(deps.db, session.firmId, persisted);

        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'cloudflare_tunnel_config',
          entityId: tunnel.id,
          actorAppUserId: session.appUserId,
          after: {
            tunnelId: tunnel.id,
            hostnames: hostnames.map((h) => `${h.realm}:${h.hostname}`),
            ingressCount: ingress.length,
          },
        }).catch(() => undefined);

        res.json({
          ok: true,
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
          zoneName: zone.name,
          hostnameCount: hostnames.length,
          ingressCount: ingress.length,
          portalIngressActive: ingress.some(
            (r) => r.originRequest?.httpHostHeader === `portal.${zone.name}`,
          ),
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
  // POST /update — edit the hostname list in place. Reuses the stored API
  // token + account/zone; reconciles DNS (adds new CNAMEs, deletes removed
  // ones) and rebuilds tunnel ingress WITHOUT deleting/recreating the
  // tunnel. The run-token is unchanged so the sidecar keeps running.
  // ---------------------------------------------------------------------
  router.post(
    '/update',
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
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const next = parsed.data.hostnames;

      const [row] = await deps.db
        .select()
        .from(cloudflareTunnelConfigs)
        .where(eq(cloudflareTunnelConfigs.firmId, session.firmId))
        .limit(1);
      if (!row || !row.tunnelId || !row.apiTokenEncrypted || !row.zoneId || !row.zoneName) {
        res.status(404).json({ error: 'no_tunnel' });
        return;
      }

      const keyMgr = getFirmKeyManager(deps.db);
      const apiToken = fromBytes(keyMgr.unwrapTDek(session.firmId, row.apiTokenEncrypted));
      const cf = createCloudflareClient({ apiToken });

      // Existing hostname rows (with DNS record ids) for the diff.
      const existingRows = await deps.db
        .select()
        .from(cloudflareTunnelHostnames)
        .where(eq(cloudflareTunnelHostnames.firmId, session.firmId));
      const nextHosts = new Set(next.map((h) => h.hostname.toLowerCase()));

      try {
        const zoneId = row.zoneId;
        const zoneName = row.zoneName;
        const cnameTarget = `${row.tunnelId}.cfargotunnel.com`;

        // Rebuild ingress first (single API call; authoritative).
        const ingress = buildIngress(
          next,
          zoneName,
          deps.commercialLicenseActive,
          originService,
          esignOriginService,
        );
        await cf.setTunnelIngress(row.accountId ?? '', row.tunnelId, { ingress });

        // Delete DNS for removed hostnames.
        for (const r of existingRows) {
          if (nextHosts.has(r.hostname.toLowerCase())) continue;
          if (r.dnsRecordId) {
            try {
              await cf.deleteDnsRecord(zoneId, r.dnsRecordId);
            } catch (err) {
              logger.warn({ err, hostname: r.hostname }, 'cf tunnel: stale DNS delete failed');
            }
          }
        }

        // Upsert DNS for the new list; carry forward existing record ids.
        const persisted: Array<HostnameSpec & { dnsRecordId: string | null }> = [];
        for (const h of next) {
          if ((h.realm === 'PORTAL' || h.realm === 'INTAKE') && !deps.commercialLicenseActive) {
            persisted.push({ ...h, dnsRecordId: null });
            continue;
          }
          const rec = await cf.upsertCnameRecord(zoneId, h.hostname, cnameTarget);
          persisted.push({ hostname: h.hostname, realm: h.realm, dnsRecordId: rec.id });
        }

        const staffHostname = firstOfRealm(next, 'STAFF');
        const portalHostname = firstOfRealm(next, 'PORTAL');
        await deps.db
          .update(cloudflareTunnelConfigs)
          .set({ staffHostname, portalHostname, lastError: null, updatedAt: new Date() })
          .where(eq(cloudflareTunnelConfigs.firmId, session.firmId));
        await persistHostnames(deps.db, session.firmId, persisted);

        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'cloudflare_tunnel_config',
          entityId: row.tunnelId,
          actorAppUserId: session.appUserId,
          after: { hostnames: next.map((h) => `${h.realm}:${h.hostname}`) },
        }).catch(() => undefined);

        res.json({ ok: true, hostnameCount: next.length, ingressCount: ingress.length });
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
        logger.error({ err }, 'cf tunnel update failed');
        res.status(502).json({ error: 'update_failed', message });
      }
    },
  );

  // ---------------------------------------------------------------------
  // POST /deprovision — delete the tunnel + all DNS records, clear the
  // row + hostname list.
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

      // Delete DNS for every recorded hostname (prefer the stored record
      // id; fall back to a name lookup).
      if (row.zoneId) {
        const hostRows = await deps.db
          .select()
          .from(cloudflareTunnelHostnames)
          .where(eq(cloudflareTunnelHostnames.firmId, session.firmId));
        for (const h of hostRows) {
          try {
            if (h.dnsRecordId) {
              await cf.deleteDnsRecord(row.zoneId, h.dnsRecordId);
            } else {
              const rec = await cf.findDnsRecord(row.zoneId, h.hostname);
              if (rec) await cf.deleteDnsRecord(row.zoneId, rec.id);
            }
          } catch (err) {
            errors.push(err instanceof Error ? err.message : `dns:${h.hostname}`);
          }
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
        .delete(cloudflareTunnelHostnames)
        .where(eq(cloudflareTunnelHostnames.firmId, session.firmId));

      await deps.db
        .update(cloudflareTunnelConfigs)
        .set({
          status: 'INACTIVE',
          tunnelId: null,
          tunnelName: null,
          tunnelTokenEncrypted: null,
          apiTokenEncrypted: null,
          apiTokenHint: null,
          staffHostname: null,
          portalHostname: null,
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
  // GET /status — cached metrics snapshot from the worker poll.
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
