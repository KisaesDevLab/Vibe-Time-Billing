// SPDX-License-Identifier: Elastic-2.0
//
// The Admin → Messaging EMAIL provider config must actually drive real
// sends (not just the test button). loadFirmMailProvider decrypts the
// firm's stored config and builds the matching provider; wrapMailWithFirmConfig
// prefers it over the env base mailer and falls back when absent.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';

import { crypto as core } from '@vibe/core';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { loadFirmMailProvider, wrapMailWithFirmConfig } from '../messaging/mail-resolver';
import type { MailMessage, MailProvider } from '../mail/provider';

// 32-byte key as 64 hex chars (AES-256).
const KMS_KEY = 'a'.repeat(64);
const log = pino({ enabled: false });

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  process.env['KMS_KEY'] = KMS_KEY;
});

afterEach(async () => {
  await harness.close();
});

function storeEmailConfig(cfg: Record<string, unknown>): string {
  return core.encryptJson(cfg, core.resolveKey(KMS_KEY));
}

describe('firm mail provider resolver', () => {
  it('builds the firm-saved emailit provider from the stored config', async () => {
    const { firmId } = await seedMinimalFirm(harness.db);
    const envelope = storeEmailConfig({
      provider: 'emailit',
      from: 'billing@firm.example',
      apiKey: 'secret-key-1234',
    });
    await harness.db.execute(
      sql`INSERT INTO firm_settings (firm_id, mail_config_encrypted)
          VALUES (${firmId}, ${envelope})`,
    );

    const provider = await loadFirmMailProvider(harness.db, firmId, log);
    expect(provider?.id).toBe('emailit');
  });

  it('returns null when the firm has no stored config (caller uses env)', async () => {
    const { firmId } = await seedMinimalFirm(harness.db);
    await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${firmId})`);
    const provider = await loadFirmMailProvider(harness.db, firmId, log);
    expect(provider).toBeNull();
  });

  it('wrap routes the send to the DB provider, not the env base', async () => {
    const { firmId } = await seedMinimalFirm(harness.db);
    // Stored SMTP config points at a sentinel host; the send fails to
    // connect but proves the DB provider (id smtp) was chosen, not base.
    const envelope = storeEmailConfig({
      provider: 'smtp',
      from: 'billing@firm.example',
      host: 'smtp.invalid.example',
      port: 587,
    });
    await harness.db.execute(
      sql`INSERT INTO firm_settings (firm_id, mail_config_encrypted)
          VALUES (${firmId}, ${envelope})`,
    );

    let baseCalled = false;
    const base: MailProvider = {
      id: 'console',
      async send(_msg: MailMessage) {
        baseCalled = true;
        return { ok: true };
      },
    };
    const wrapped = wrapMailWithFirmConfig(base, { db: harness.db, log });
    await wrapped.send({ to: 'x@y.example', subject: 's', body: 'b' });
    // The DB smtp provider handled it (and failed to connect); base untouched.
    expect(baseCalled).toBe(false);
  });

  it('wrap falls back to the env base provider when no DB config exists', async () => {
    const { firmId } = await seedMinimalFirm(harness.db);
    await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${firmId})`);

    let baseCalled = false;
    const base: MailProvider = {
      id: 'console',
      async send(_msg: MailMessage) {
        baseCalled = true;
        return { ok: true };
      },
    };
    const wrapped = wrapMailWithFirmConfig(base, { db: harness.db, log });
    const r = await wrapped.send({ to: 'x@y.example', subject: 's', body: 'b' });
    expect(baseCalled).toBe(true);
    expect(r.ok).toBe(true);
  });
});
