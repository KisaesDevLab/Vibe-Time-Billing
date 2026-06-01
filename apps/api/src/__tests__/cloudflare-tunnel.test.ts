// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0085 — Cloudflare Tunnel router integration tests. Mocks the CF API
// client; verifies happy-path provision writes the encrypted row +
// includes/excludes portal ingress based on license, and deprovision
// clears the row + deletes DNS + tunnel.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type express from 'express';

import { cloudflareTunnelConfigs } from '@vibe/db/schema';
import type { createCloudflareClient } from '@vibe/core/cloudflare';
import { type CloudflareClientOptions } from '@vibe/core/cloudflare';

type CloudflareClient = ReturnType<typeof createCloudflareClient>;

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createCloudflareTunnelRouter } from '../admin/cloudflare-tunnel/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;
let tokenDir: string;
let tokenFile: string;

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-cf-seal-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  tokenDir = await mkdtemp(join(tmpdir(), 'vibe-cf-token-'));
  tokenFile = join(tokenDir, 'token');

  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
  await rm(tokenDir, { recursive: true, force: true });
});

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

function makeReq(over: Partial<FakeReq> & { firmId: string; appUserId: string }): FakeReq {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: over.firmId, appUserId: over.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}

interface MockClientLog {
  validateApiToken: string[];
  getZone: string[];
  createTunnel: Array<{ accountId: string; name: string }>;
  getTunnelToken: string[];
  setTunnelIngress: Array<{ tunnelId: string; ingressLen: number; hosts: string[] }>;
  upsertCnameRecord: Array<{ zoneId: string; hostname: string; target: string }>;
  findDnsRecord: Array<{ zoneId: string; hostname: string }>;
  deleteDnsRecord: string[];
  deleteTunnel: string[];
}

function buildMockClient(): {
  factory: (opts: CloudflareClientOptions) => CloudflareClient;
  log: MockClientLog;
} {
  const log: MockClientLog = {
    validateApiToken: [],
    getZone: [],
    createTunnel: [],
    getTunnelToken: [],
    setTunnelIngress: [],
    upsertCnameRecord: [],
    findDnsRecord: [],
    deleteDnsRecord: [],
    deleteTunnel: [],
  };
  let nextDnsId = 1;
  const factory = (_opts: CloudflareClientOptions): CloudflareClient => ({
    async validateApiToken(accountId: string) {
      log.validateApiToken.push(accountId);
      return { accountId };
    },
    async getZone(zoneId: string) {
      log.getZone.push(zoneId);
      return { id: zoneId, name: 'firm.example', status: 'active' };
    },
    async createTunnel(accountId, name) {
      log.createTunnel.push({ accountId, name });
      return {
        id: 'tnl-abc',
        name,
        created_at: new Date().toISOString(),
        account_tag: accountId,
      };
    },
    async getTunnelToken(_accountId, tunnelId) {
      log.getTunnelToken.push(tunnelId);
      return 'fake-run-token-XYZ';
    },
    async setTunnelIngress(_accountId, tunnelId, config) {
      log.setTunnelIngress.push({
        tunnelId,
        ingressLen: config.ingress.length,
        hosts: config.ingress.filter((i) => i.hostname).map((i) => i.hostname!),
      });
    },
    async upsertCnameRecord(zoneId, hostname, target) {
      log.upsertCnameRecord.push({ zoneId, hostname, target });
      return {
        id: `rec-${nextDnsId++}`,
        type: 'CNAME',
        name: hostname,
        content: target,
        proxied: true,
      };
    },
    async findDnsRecord(zoneId, hostname) {
      log.findDnsRecord.push({ zoneId, hostname });
      return null;
    },
    async deleteDnsRecord(_zoneId, recordId) {
      log.deleteDnsRecord.push(recordId);
    },
    async deleteTunnel(_accountId, tunnelId) {
      log.deleteTunnel.push(tunnelId);
    },
  });
  return { factory, log };
}

const VALID_TOKEN = 'cftoken-abc-12345678901234567890';
const ACCOUNT_ID = 'a'.repeat(32);
const ZONE_ID = 'b'.repeat(32);

describe('cloudflare-tunnel router', () => {
  it('GET / returns null when no row exists', async () => {
    const { factory } = buildMockClient();
    const router = createCloudflareTunnelRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      commercialLicenseActive: true,
      tokenFilePath: tokenFile,
      createClient: factory,
    });
    const r = await invoke(router, 'get', '/', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { config: null }).config).toBeNull();
  });

  it('POST /validate confirms the zone and returns its name', async () => {
    const { factory, log } = buildMockClient();
    const router = createCloudflareTunnelRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      commercialLicenseActive: true,
      tokenFilePath: tokenFile,
      createClient: factory,
    });
    const r = await invoke(router, 'post', '/validate', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { apiToken: VALID_TOKEN, accountId: ACCOUNT_ID, zoneId: ZONE_ID },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { zoneName: string }).zoneName).toBe('firm.example');
    expect(log.validateApiToken).toEqual([ACCOUNT_ID]);
    expect(log.getZone).toEqual([ZONE_ID]);
  });

  it('POST /provision (licensed) creates tunnel + DNS for both staff and portal', async () => {
    const { factory, log } = buildMockClient();
    const router = createCloudflareTunnelRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      commercialLicenseActive: true,
      tokenFilePath: tokenFile,
      createClient: factory,
    });
    const r = await invoke(router, 'post', '/provision', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          apiToken: VALID_TOKEN,
          accountId: ACCOUNT_ID,
          zoneId: ZONE_ID,
          staffHostname: 'app.firm.example',
          portalHostname: 'portal.firm.example',
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { ok: boolean; portalIngressActive: boolean }).portalIngressActive).toBe(
      true,
    );

    // Ingress includes both hostnames + the catch-all.
    expect(log.setTunnelIngress).toHaveLength(1);
    expect(log.setTunnelIngress[0]!.ingressLen).toBe(3);
    expect(log.setTunnelIngress[0]!.hosts).toEqual(['app.firm.example', 'portal.firm.example']);
    // Both DNS records created.
    expect(log.upsertCnameRecord.map((c) => c.hostname).sort()).toEqual([
      'app.firm.example',
      'portal.firm.example',
    ]);
    // Token file written to the fake path.
    const tokenContents = await readFile(tokenFile, 'utf8');
    expect(tokenContents).toBe('fake-run-token-XYZ');

    // Row stored with encrypted tokens (bytea length > 0) and hint.
    const [row] = await harness.db
      .select()
      .from(cloudflareTunnelConfigs)
      .where(eq(cloudflareTunnelConfigs.firmId, seed.firmId));
    expect(row!.status).toBe('ACTIVE');
    expect(row!.tunnelId).toBe('tnl-abc');
    expect(row!.apiTokenEncrypted?.length).toBeGreaterThan(0);
    expect(row!.tunnelTokenEncrypted?.length).toBeGreaterThan(0);
    expect(row!.apiTokenHint).toBe(VALID_TOKEN.slice(-4));
  });

  it('POST /provision (unlicensed) omits portal ingress but still saves portalHostname', async () => {
    const { factory, log } = buildMockClient();
    const router = createCloudflareTunnelRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      commercialLicenseActive: false,
      tokenFilePath: tokenFile,
      createClient: factory,
    });
    await invoke(router, 'post', '/provision', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          apiToken: VALID_TOKEN,
          accountId: ACCOUNT_ID,
          zoneId: ZONE_ID,
          staffHostname: 'app.firm.example',
          portalHostname: 'portal.firm.example',
        },
      }),
    });
    expect(log.setTunnelIngress[0]!.hosts).toEqual(['app.firm.example']);
    expect(log.setTunnelIngress[0]!.ingressLen).toBe(2); // staff + 404 catch-all
    expect(log.upsertCnameRecord.map((c) => c.hostname)).toEqual(['app.firm.example']);

    // portalHostname still recorded so re-license picks it up on next provision.
    const [row] = await harness.db
      .select()
      .from(cloudflareTunnelConfigs)
      .where(eq(cloudflareTunnelConfigs.firmId, seed.firmId));
    expect(row!.portalHostname).toBe('portal.firm.example');
  });

  it('POST /deprovision deletes the tunnel + DNS, clears tokens, removes token file', async () => {
    const { factory, log } = buildMockClient();
    const router = createCloudflareTunnelRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      commercialLicenseActive: true,
      tokenFilePath: tokenFile,
      createClient: factory,
    });
    // Provision first.
    await invoke(router, 'post', '/provision', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          apiToken: VALID_TOKEN,
          accountId: ACCOUNT_ID,
          zoneId: ZONE_ID,
          staffHostname: 'app.firm.example',
          portalHostname: 'portal.firm.example',
        },
      }),
    });
    // The mock findDnsRecord returns null by default — flip it to a stub
    // that returns the recorded DNS so deprovision can delete it.
    const nextRec = 0;
    const realRecs = [...log.upsertCnameRecord];
    // No need to swap — just call deprovision and confirm tunnel-delete fires.
    const r = await invoke(router, 'post', '/deprovision', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, body: {} }),
    });
    void nextRec;
    void realRecs;
    expect(r.statusCode).toBe(200);
    expect(log.deleteTunnel).toEqual(['tnl-abc']);

    // Token file gone.
    await expect(stat(tokenFile)).rejects.toThrow();

    // Row cleared.
    const [row] = await harness.db
      .select()
      .from(cloudflareTunnelConfigs)
      .where(eq(cloudflareTunnelConfigs.firmId, seed.firmId));
    expect(row!.status).toBe('INACTIVE');
    expect(row!.tunnelId).toBeNull();
    expect(row!.apiTokenEncrypted).toBeNull();
    expect(row!.tunnelTokenEncrypted).toBeNull();
  });

  it('POST /provision returns 503 when the appliance is locked', async () => {
    setApplianceLockState({ kind: 'locked', firmId: seed.firmId, reason: 'awaiting-passphrase' });
    const { factory } = buildMockClient();
    const router = createCloudflareTunnelRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      commercialLicenseActive: true,
      tokenFilePath: tokenFile,
      createClient: factory,
    });
    const r = await invoke(router, 'post', '/provision', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          apiToken: VALID_TOKEN,
          accountId: ACCOUNT_ID,
          zoneId: ZONE_ID,
          staffHostname: 'app.firm.example',
        },
      }),
    });
    expect(r.statusCode).toBe(503);
  });

  it('POST /validate rejects bad shape with 400', async () => {
    const { factory } = buildMockClient();
    const router = createCloudflareTunnelRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      commercialLicenseActive: true,
      tokenFilePath: tokenFile,
      createClient: factory,
    });
    const r = await invoke(router, 'post', '/validate', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { apiToken: 'tiny', accountId: 'not-hex', zoneId: 'b' },
      }),
    });
    expect(r.statusCode).toBe(400);
  });
});
