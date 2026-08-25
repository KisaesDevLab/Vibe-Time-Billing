// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// PGW-1 (0228) — multi-gateway resolution precedence (explicit gatewayId
// → office gateway → firm default → legacy firm_settings blob → env),
// no-silent-fallback for a deleted explicit gateway (D-PGW-06),
// deterministic office-printer picks (D-PGW-08), and cross-office
// isolation.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { crypto as core } from '@vibe/core';
import { offices, printGateways, printerAssignments } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { encryptGatewayApiKey, listGateways, resolvePrintGateway } from '../print-gateway/config';
import {
  resolveOfficePrinterTarget,
  resolvePreselectPrinterTarget,
} from '../print-gateway/assignments';

const KMS_KEY = 'a'.repeat(64);

let harness: PgliteHarness;
let firmId: string;
let officeA: string; // seed HQ
let officeB: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  process.env['KMS_KEY'] = KMS_KEY;
  delete process.env['PRINT_GATEWAY_BASE_URL'];
  delete process.env['PRINT_GATEWAY_API_KEY'];
  const seed = await seedMinimalFirm(harness.db);
  firmId = seed.firmId;
  const rows = await harness.db
    .select({ id: offices.id })
    .from(offices)
    .where(sql`${offices.firmId} = ${firmId}`);
  officeA = rows[0]!.id;
  const [b] = await harness.db
    .insert(offices)
    .values({ firmId, name: 'Branch', timezone: 'America/Chicago' })
    .returning({ id: offices.id });
  officeB = b!.id;
});

afterEach(async () => {
  delete process.env['PRINT_GATEWAY_BASE_URL'];
  delete process.env['PRINT_GATEWAY_API_KEY'];
  await harness.close();
});

async function addGateway(args: {
  name: string;
  officeId?: string | null;
  isDefault?: boolean;
  enabled?: boolean;
  baseUrl?: string;
}): Promise<string> {
  const [row] = await harness.db
    .insert(printGateways)
    .values({
      firmId,
      name: args.name,
      officeId: args.officeId ?? null,
      isDefault: args.isDefault ?? false,
      enabled: args.enabled ?? true,
      baseUrl: args.baseUrl ?? `http://${args.name}.lan:8080`,
      apiKeyEncrypted: encryptGatewayApiKey(`key-${args.name}`),
    })
    .returning({ id: printGateways.id });
  return row!.id;
}

describe('resolvePrintGateway precedence', () => {
  it('falls back to the legacy firm_settings blob while the table is empty', async () => {
    const envelope = core.encryptJson(
      { baseUrl: 'http://legacy.lan:8080/', apiKey: 'legacy-key', enabled: true },
      core.resolveKey(KMS_KEY),
    );
    await harness.db.execute(
      sql`INSERT INTO firm_settings (firm_id, print_gateway_config_encrypted)
          VALUES (${firmId}, ${envelope})`,
    );
    const gw = await resolvePrintGateway(harness.db, firmId);
    expect(gw?.id).toBe('legacy');
    expect(gw?.baseUrl).toBe('http://legacy.lan:8080');
    expect(gw?.apiKey).toBe('legacy-key');
  });

  it('falls back to the env pair when neither table rows nor blob exist', async () => {
    process.env['PRINT_GATEWAY_BASE_URL'] = 'http://env.lan:8080';
    process.env['PRINT_GATEWAY_API_KEY'] = 'env-key';
    const gw = await resolvePrintGateway(harness.db, firmId);
    expect(gw?.id).toBe('env');
    expect(gw?.enabled).toBe(true);
  });

  it('table rows win over blob and env; office beats default; explicit beats all', async () => {
    // A blob AND env pair exist — both must be ignored once rows exist.
    const envelope = core.encryptJson(
      { baseUrl: 'http://legacy.lan:8080', apiKey: 'legacy-key', enabled: true },
      core.resolveKey(KMS_KEY),
    );
    await harness.db.execute(
      sql`INSERT INTO firm_settings (firm_id, print_gateway_config_encrypted)
          VALUES (${firmId}, ${envelope})`,
    );
    process.env['PRINT_GATEWAY_BASE_URL'] = 'http://env.lan:8080';
    process.env['PRINT_GATEWAY_API_KEY'] = 'env-key';

    const defaultId = await addGateway({ name: 'hq', isDefault: true });
    const branchId = await addGateway({ name: 'branch', officeId: officeB });

    // No context → firm default.
    const plain = await resolvePrintGateway(harness.db, firmId);
    expect(plain?.id).toBe(defaultId);
    expect(plain?.apiKey).toBe('key-hq');

    // Office with its own gateway → that gateway.
    const forB = await resolvePrintGateway(harness.db, firmId, { officeId: officeB });
    expect(forB?.id).toBe(branchId);
    expect(forB?.officeId).toBe(officeB);

    // Office without a gateway → firm default.
    const forA = await resolvePrintGateway(harness.db, firmId, { officeId: officeA });
    expect(forA?.id).toBe(defaultId);

    // Explicit gateway id → exactly that row.
    const explicit = await resolvePrintGateway(harness.db, firmId, { gatewayId: branchId });
    expect(explicit?.id).toBe(branchId);
  });

  it('an explicit gatewayId that no longer exists fails — no silent fallback', async () => {
    await addGateway({ name: 'hq', isDefault: true });
    const gone = await resolvePrintGateway(harness.db, firmId, {
      gatewayId: '00000000-0000-4000-8000-000000000000',
    });
    expect(gone).toBeNull();
  });

  it('a disabled office gateway is still returned (caller distinguishes off)', async () => {
    await addGateway({ name: 'hq', isDefault: true });
    const offId = await addGateway({ name: 'branch', officeId: officeB, enabled: false });
    const gw = await resolvePrintGateway(harness.db, firmId, { officeId: officeB });
    expect(gw?.id).toBe(offId);
    expect(gw?.enabled).toBe(false);
  });

  it('listGateways masks keys and joins office names', async () => {
    await addGateway({ name: 'branch', officeId: officeB });
    const list = await listGateways(harness.db, firmId);
    expect(list).toHaveLength(1);
    expect(list[0]!.officeName).toBe('Branch');
    expect(list[0]!.apiKeyMasked).toBe('••••anch'); // key-branch → last 4
    expect(JSON.stringify(list)).not.toContain('key-branch');
  });
});

describe('office printer targets (D-PGW-08)', () => {
  async function addPrinter(args: {
    printerId: number;
    officeId: string;
    gatewayId?: string | null;
    isOfficeDefault?: boolean;
    enabled?: boolean;
    createdAt?: Date;
  }): Promise<void> {
    await harness.db.insert(printerAssignments).values({
      firmId,
      gatewayPrinterId: args.printerId,
      gatewayId: args.gatewayId ?? null,
      officeId: args.officeId,
      enabled: args.enabled ?? true,
      isOfficeDefault: args.isOfficeDefault ?? false,
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    });
  }

  it('is_office_default wins, then created_at; disabled rows never resolve', async () => {
    const gwId = await addGateway({ name: 'branch', officeId: officeB });
    await addPrinter({
      printerId: 1,
      officeId: officeB,
      gatewayId: gwId,
      createdAt: new Date('2026-01-01'),
    });
    await addPrinter({
      printerId: 2,
      officeId: officeB,
      gatewayId: gwId,
      isOfficeDefault: true,
      createdAt: new Date('2026-06-01'),
    });

    const pick = await resolveOfficePrinterTarget(harness.db, firmId, officeB);
    expect(pick).toEqual({ gatewayId: gwId, printerId: 2 });

    // Without the default flag the oldest assignment wins.
    await harness.db
      .update(printerAssignments)
      .set({ isOfficeDefault: false })
      .where(sql`${printerAssignments.gatewayPrinterId} = 2`);
    const oldest = await resolveOfficePrinterTarget(harness.db, firmId, officeB);
    expect(oldest?.printerId).toBe(1);

    await harness.db
      .update(printerAssignments)
      .set({ enabled: false })
      .where(sql`${printerAssignments.officeId} = ${officeB}`);
    expect(await resolveOfficePrinterTarget(harness.db, firmId, officeB)).toBeNull();
  });

  it('never returns another office’s printer', async () => {
    await addPrinter({ printerId: 7, officeId: officeA });
    expect(await resolveOfficePrinterTarget(harness.db, firmId, officeB)).toBeNull();
    const a = await resolveOfficePrinterTarget(harness.db, firmId, officeA);
    expect(a).toEqual({ gatewayId: null, printerId: 7 });
  });

  it('preselect: remembered pair → office printer → firm default', async () => {
    const gwId = await addGateway({ name: 'branch', officeId: officeB });
    await addPrinter({ printerId: 3, officeId: officeB, gatewayId: gwId });

    const remembered = await resolvePreselectPrinterTarget(harness.db, firmId, {
      userDefaultPrinterId: 9,
      userDefaultPrinterGatewayId: gwId,
      userOfficeId: officeB,
      firmDefault: 1,
    });
    expect(remembered).toEqual({ gatewayId: gwId, printerId: 9 });

    const viaOffice = await resolvePreselectPrinterTarget(harness.db, firmId, {
      userDefaultPrinterId: null,
      userOfficeId: officeB,
      firmDefault: 1,
    });
    expect(viaOffice).toEqual({ gatewayId: gwId, printerId: 3 });

    const viaFirm = await resolvePreselectPrinterTarget(harness.db, firmId, {
      userDefaultPrinterId: null,
      userOfficeId: officeA,
      firmDefault: 1,
      firmDefaultGatewayId: gwId,
    });
    expect(viaFirm).toEqual({ gatewayId: gwId, printerId: 1 });

    const none = await resolvePreselectPrinterTarget(harness.db, firmId, {
      userDefaultPrinterId: null,
      userOfficeId: null,
      firmDefault: null,
    });
    expect(none).toBeNull();
  });
});
