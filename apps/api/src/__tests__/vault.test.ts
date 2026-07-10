// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0159 — per-client credential vault. Proves: the MFK-envelope field crypto
// round-trips; the list endpoint never returns secret material; reveal returns
// plaintext only with a fresh step-up (403 otherwise); archive hides a row;
// cross-client access 404s; and create/reveal/archive write audit rows.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditLog, clientCredentials } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { newCredentialKey, unwrapCredentialKey, encField, decField } from '../vault/crypto';
import { createClientCredentialRouter } from '../vault/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;
let stepUpAt: number | null;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      lastStepUpAt: stepUpAt,
    };
    next();
  });
  app.use(
    '/api/staff/clients/:id/credentials',
    createClientCredentialRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    }),
  );
  return app;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-vault-seal-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  stepUpAt = Date.now(); // fresh by default
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('vault column crypto', () => {
  it('round-trips a credential field through the MFK envelope', () => {
    const { dek, wrappedDek } = newCredentialKey(harness.db, seed.firmId);
    const ct = encField(dek, 'hunter2');
    expect(ct).not.toBeNull();
    expect(ct?.toString('utf8')).not.toContain('hunter2');
    const recovered = unwrapCredentialKey(harness.db, seed.firmId, wrappedDek);
    expect(decField(recovered, ct)).toBe('hunter2');
  });
});

describe('vault routes', () => {
  async function create(app: express.Express): Promise<string> {
    const res = await request(app).post(`/api/staff/clients/${seed.clientId}/credentials`).send({
      title: 'IRS e-Services',
      category: 'irs',
      username: 'preparer@firm.example',
      password: 'S3cret!pw',
      url: 'https://la.www4.irs.gov',
      notes: 'PTIN account',
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('lists metadata only — never secret material', async () => {
    const app = buildApp();
    await create(app);
    const res = await request(app).get(`/api/staff/clients/${seed.clientId}/credentials`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const row = res.body.items[0];
    expect(row.title).toBe('IRS e-Services');
    expect(row.hasPassword).toBe(true);
    // No secret/ciphertext anywhere in the list payload.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('S3cret!pw');
    expect(json).not.toContain('passwordEnc');
    expect(json).not.toContain('preparer@firm.example');
  });

  it('reveals plaintext with a fresh step-up', async () => {
    const app = buildApp();
    const id = await create(app);
    const res = await request(app).post(
      `/api/staff/clients/${seed.clientId}/credentials/${id}/reveal`,
    );
    expect(res.status).toBe(200);
    expect(res.body.password).toBe('S3cret!pw');
    expect(res.body.username).toBe('preparer@firm.example');
  });

  it('refuses reveal without a fresh step-up', async () => {
    const app = buildApp();
    const id = await create(app);
    stepUpAt = null; // stale; firm defaults to second-factor REQUIRED
    const res = await request(app).post(
      `/api/staff/clients/${seed.clientId}/credentials/${id}/reveal`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('step_up_required');
  });

  it('stores ciphertext (not plaintext) in the row', async () => {
    const app = buildApp();
    const id = await create(app);
    const [row] = await harness.db
      .select()
      .from(clientCredentials)
      .where(eq(clientCredentials.id, id));
    expect(Buffer.from(row!.passwordEnc!).toString('utf8')).not.toContain('S3cret!pw');
    expect(row!.hint).toContain('***');
  });

  it('archive hides the credential from the list', async () => {
    const app = buildApp();
    const id = await create(app);
    const del = await request(app).delete(`/api/staff/clients/${seed.clientId}/credentials/${id}`);
    expect(del.status).toBe(200);
    const res = await request(app).get(`/api/staff/clients/${seed.clientId}/credentials`);
    expect(res.body.items).toHaveLength(0);
  });

  it('404s for a credential under a different client', async () => {
    const app = buildApp();
    const id = await create(app);
    const other = '00000000-0000-0000-0000-000000000000';
    const res = await request(app).post(`/api/staff/clients/${other}/credentials/${id}/reveal`);
    expect(res.status).toBe(404);
  });

  it('writes audit rows for create, reveal, and archive', async () => {
    const app = buildApp();
    const id = await create(app);
    await request(app).post(`/api/staff/clients/${seed.clientId}/credentials/${id}/reveal`);
    await request(app).delete(`/api/staff/clients/${seed.clientId}/credentials/${id}`);
    const rows = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, 'client_credential'));
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(['ARCHIVE', 'CREATE', 'STEP_UP']);
    // No audit row leaks the secret.
    expect(JSON.stringify(rows)).not.toContain('S3cret!pw');
  });
});
