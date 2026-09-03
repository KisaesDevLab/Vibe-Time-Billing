// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Regressions for the outbound gates found by review:
//   - legacy mode (the DEFAULT, since sms_inbox_enabled is false) skipped
//     the opt-out check for every caller that passes no personId — which
//     is most of them, including sendPortalSms;
//   - the inbox consent gate keyed on a single resolved personId, so a
//     number shared by two people bypassed it entirely.

import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crypto as core } from '@vibe/core';
import { persons } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { createSmsSendService } from '../sms/send-service';

const KMS_KEY = 'a'.repeat(64);
const AC = 'AC' + 'a'.repeat(32);
const MG = 'MG' + 'b'.repeat(32);
const log = pino({ enabled: false });
const NUMBER = '+13125550148';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sentViaFallback: Array<{ to: string; body: string }>;

function fallback() {
  return {
    send: async (a: { to: string; body: string }) => {
      sentViaFallback.push(a);
      return { ok: true as const, providerMessageId: 'legacy-1' };
    },
  };
}

function service() {
  return createSmsSendService({
    db: harness.db,
    log,
    // reason: the legacy provider seam only needs send() in these tests
    fallback: fallback() as never,
    config: { APP_BASE_URL: 'http://localhost:3001' },
  });
}

async function enableInbox(consentEnforced: boolean): Promise<void> {
  process.env['KMS_KEY'] = KMS_KEY;
  const envelope = core.encryptJson(
    { provider: 'twilio', accountSid: AC, authToken: 'token-12345', messagingServiceSid: MG },
    core.resolveKey(KMS_KEY),
  );
  await harness.db.execute(
    sql`UPDATE firm_settings SET sms_config_encrypted = ${envelope}, sms_inbox_enabled = true,
        sms_consent_enforced = ${consentEnforced} WHERE firm_id = ${seed.firmId}`,
  );
  await seedSmsLine(harness.db, { firmId: seed.firmId });
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  sentViaFallback = [];
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
});

afterEach(async () => {
  await harness.close();
});

describe('legacy mode honours opt-out without an explicit personId', () => {
  it('refuses to text someone who sent STOP', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Client',
      mobile: NUMBER,
    });
    await harness.db.update(persons).set({ smsOptOut: true }).where(eq(persons.id, personId));

    // sendPortalSms and friends build this context — no personId, no firmId
    // on the caller's side beyond what we pass here.
    const r = await service().send({
      to: NUMBER,
      body: 'Your portal invite',
      context: { kind: 'notification', subKind: 'portal_invite', firmId: seed.firmId },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('opted_out');
    expect(sentViaFallback).toHaveLength(0);
  });

  it('still delivers to someone who has not opted out', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Client',
      mobile: NUMBER,
    });
    const r = await service().send({
      to: NUMBER,
      body: 'Your portal invite',
      context: { kind: 'notification', subKind: 'portal_invite', firmId: seed.firmId },
    });
    expect(r.ok).toBe(true);
    expect(sentViaFallback).toHaveLength(1);
  });

  it('never blocks a security code', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Client',
      mobile: NUMBER,
    });
    await harness.db.update(persons).set({ smsOptOut: true }).where(eq(persons.id, personId));
    const r = await service().send({
      to: NUMBER,
      body: 'Your code is 123456',
      context: { kind: 'security', firmId: seed.firmId },
    });
    expect(r.ok).toBe(true);
  });
});

describe('inbox consent gate covers ambiguous numbers', () => {
  it('blocks a household number where nobody has consented', async () => {
    await enableInbox(true);
    // Two people share the landline and neither has a consent record.
    for (const name of ['Spouse A', 'Spouse B']) {
      await seedContact(harness.db, {
        firmId: seed.firmId,
        clientId: seed.clientId,
        fullName: name,
        mobile: NUMBER,
      });
    }
    const r = await service().send({
      to: NUMBER,
      body: 'A reminder',
      context: { kind: 'notification', subKind: 'other', firmId: seed.firmId },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('no_consent');
  });

  it('allows the same number once one holder has consented', async () => {
    await enableInbox(true);
    const a = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Spouse A',
      mobile: NUMBER,
    });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Spouse B',
      mobile: NUMBER,
    });
    await harness.db
      .update(persons)
      .set({ smsConsentAt: new Date(), smsConsentSource: 'verbal' })
      .where(eq(persons.id, a.personId));
    const r = await service().send({
      to: NUMBER,
      body: 'A reminder',
      context: { kind: 'notification', subKind: 'other', firmId: seed.firmId },
    });
    expect(r.ok === false && r.reason).not.toBe('no_consent');
  });
});
