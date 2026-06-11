// SPDX-License-Identifier: Elastic-2.0
//
// Phase 6 + 8 — verify the activated/exhausted notification helpers
// resolve recipients correctly (client billing contact + partner +
// engagement-assigned staff) and dispatch the right per-recipient
// copy via the injected mail dispatch.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import {
  notifyRetainerActivated,
  notifyRetainerExhausted,
  type RetainerMailDispatch,
} from '../retainers/notifications';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface CapturedMail {
  to: string;
  subject: string;
  body: string;
}

function makeCapture(): { send: RetainerMailDispatch; captured: CapturedMail[] } {
  const captured: CapturedMail[] = [];
  const send: RetainerMailDispatch = async (args) => {
    captured.push({ to: args.to, subject: args.subject, body: args.body });
  };
  return { send, captured };
}

async function seedRetainerFor(opts: {
  withBillingContact?: boolean;
  withSecondStaff?: boolean;
}): Promise<{ retainerId: string; firmId: string; engagementId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId, appUserId } = seed;

  if (opts.withBillingContact) {
    await seedContact(harness.db, {
      firmId,
      clientId,
      fullName: 'Pat Payer',
      email: 'pat@example.com',
      isPrimary: true,
      isBilling: true,
    });
  }

  // Ensure the client has a partner-in-charge set (seedMinimalFirm
  // already does this — but verify the email is captured).
  await harness.db.execute(
    sql`UPDATE app_user SET email = 'partner@firm.example' WHERE id = ${appUserId}`,
  );

  let secondStaffId: string | null = null;
  if (opts.withSecondStaff) {
    const r = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${firmId}, 'staff2@firm.example', 'Staff Two', 'Staff', 'Two')
          RETURNING id`,
    );
    secondStaffId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO engagement_assignment (engagement_id, app_user_id, role)
          VALUES (${engagementId}, ${secondStaffId}, 'STAFF')`,
    );
  }

  // Seed a minimal retainer row directly (skip the offer/activation
  // dance — these tests focus on notification recipients).
  const tierConfig = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps, is_active)
        VALUES (${firmId}, '1040', 'TIER_1', 'Standard', 5, 0, 0, true)
        RETURNING id`,
  );
  const tcId = (tierConfig as unknown as { rows: { id: string }[] }).rows[0]!.id;

  const retainer = await harness.db.execute(
    sql`INSERT INTO retainer
          (firm_id, client_id, engagement_id, tier_config_id, tier, return_type, tax_year,
           name, hours_purchased, hours_consumed, price_cents, purchase_date, expiry_date, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, ${tcId}, 'TIER_1', '1040', 2025,
                'Standard', 5, 5, 40000, '2026-04-15', '2029-10-15', 'exhausted')
        RETURNING id`,
  );
  const retainerId = (retainer as unknown as { rows: { id: string }[] }).rows[0]!.id;

  return { retainerId, firmId, engagementId };
}

describe('notifyRetainerActivated', () => {
  it('sends one client + one staff email when contacts resolve', async () => {
    const { retainerId } = await seedRetainerFor({
      withBillingContact: true,
      withSecondStaff: true,
    });
    const { send, captured } = makeCapture();
    await notifyRetainerActivated(harness.db, retainerId, send);
    // Expect: pat@example.com + partner@firm.example + staff2@firm.example
    expect(captured).toHaveLength(3);
    const recipients = captured.map((c) => c.to).sort();
    expect(recipients).toEqual(['partner@firm.example', 'pat@example.com', 'staff2@firm.example']);
    const clientMail = captured.find((c) => c.to === 'pat@example.com')!;
    expect(clientMail.subject).toContain('retainer is active');
    expect(clientMail.body).toContain('Hours purchased');
  });

  it('skips client email when no billing contact resolves', async () => {
    const { retainerId } = await seedRetainerFor({ withBillingContact: false });
    const { send, captured } = makeCapture();
    await notifyRetainerActivated(harness.db, retainerId, send);
    expect(captured.find((c) => c.to === 'pat@example.com')).toBeUndefined();
    // Partner still receives the staff copy.
    expect(captured.find((c) => c.to === 'partner@firm.example')).toBeDefined();
  });

  it('is a no-op when retainer id is unknown', async () => {
    const { send, captured } = makeCapture();
    await notifyRetainerActivated(harness.db, '00000000-0000-4000-8000-000000000000', send);
    expect(captured).toHaveLength(0);
  });

  it('swallows per-recipient send errors and continues', async () => {
    const { retainerId } = await seedRetainerFor({
      withBillingContact: true,
      withSecondStaff: true,
    });
    const captured: CapturedMail[] = [];
    let calls = 0;
    const send: RetainerMailDispatch = async (args) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated provider failure');
      captured.push({ to: args.to, subject: args.subject, body: args.body });
    };
    await notifyRetainerActivated(harness.db, retainerId, send);
    // One throw → two successful captures (we dispatched 3 total).
    expect(calls).toBe(3);
    expect(captured).toHaveLength(2);
  });
});

describe('notifyRetainerExhausted', () => {
  it('sends exhaustion copy to client + partner + assigned staff', async () => {
    const { retainerId } = await seedRetainerFor({
      withBillingContact: true,
      withSecondStaff: true,
    });
    const { send, captured } = makeCapture();
    await notifyRetainerExhausted(harness.db, retainerId, send);
    expect(captured).toHaveLength(3);
    const clientMail = captured.find((c) => c.to === 'pat@example.com')!;
    expect(clientMail.subject).toContain('fully consumed');
    expect(clientMail.body).toContain('billed at standard rates');
    const staffMail = captured.find((c) => c.to === 'staff2@firm.example')!;
    expect(staffMail.subject).toContain('Retainer exhausted');
  });
});
