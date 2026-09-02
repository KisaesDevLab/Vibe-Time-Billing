// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 / D8a — consent capture points: staff records / revokes verbal
// consent (audited), staff opt-out toggles carry provenance, the portal
// contact-preferences PATCH treats "turn texts back on" and an explicit
// smsConsent as portal consent, and GET /people/:id exposes the state.

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, persons, portalIdentity } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createPeopleRouter } from '../people/routes';
import { createPortalProfileRouter } from '../portal/profile';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let personId: string;

function staffApp() {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    // reason: test stub — the real middleware attaches a full StaffSession
    req.staffSession = { firmId: seed.firmId, appUserId: seed.appUserId } as never;
    next();
  });
  a.use(
    '/people',
    createPeopleRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin' as const]]]),
    }),
  );
  return a;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  ({ personId } = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Pat Client',
    mobile: '+13125550148',
  }));
});

afterEach(async () => {
  await harness.close();
});

describe('SMS consent (D8a)', () => {
  it('staff records and revokes verbal consent, audited', async () => {
    const a = staffApp();
    const before = await request(a).get(`/people/${personId}`);
    expect(before.status).toBe(200);
    expect(before.body.smsConsentAt).toBeNull();
    const r = await request(a)
      .post(`/people/${personId}/sms-consent`)
      .send({ source: 'verbal', note: 'phone call 9/2' });
    expect(r.status).toBe(200);
    expect(r.body.smsConsentSource).toBe('verbal');
    const after = await request(a).get(`/people/${personId}`);
    expect(after.body.smsConsentSource).toBe('verbal');
    expect(after.body.smsConsentAt).toBeTruthy();
    const [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsConsentByUserId).toBe(seed.appUserId);
    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, 'person'));
    expect(
      audits.some((x) => (x.afterJson as { smsAction?: string })?.smsAction === 'consent_recorded'),
    ).toBe(true);
    const del = await request(a).delete(`/people/${personId}/sms-consent`);
    expect(del.status).toBe(200);
    const [p2] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p2!.smsConsentAt).toBeNull();
    expect(
      (await request(a).post('/people/00000000-0000-0000-0000-000000000009/sms-consent').send({}))
        .status,
    ).toBe(404);
  });

  it('staff opt-out toggle carries provenance both ways', async () => {
    const a = staffApp();
    expect((await request(a).patch(`/people/${personId}`).send({ smsOptOut: true })).status).toBe(
      200,
    );
    let [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(true);
    expect(p!.smsOptOutSource).toBe('staff');
    expect(p!.smsOptOutAt).toBeTruthy();
    expect((await request(a).patch(`/people/${personId}`).send({ smsOptOut: false })).status).toBe(
      200,
    );
    [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(false);
    expect(p!.smsOptOutSource).toBeNull();
  });

  it('portal contact preferences: re-enabling texts or affirming smsConsent records portal consent', async () => {
    const ident = await harness.db
      .insert(portalIdentity)
      .values({
        firmId: seed.firmId,
        fullName: 'Pat Client',
        primaryEmail: 'pat@x.example',
        personId,
      })
      .returning({ id: portalIdentity.id });
    const identityId = ident[0]!.id;
    const a = express();
    a.use(express.json());
    a.use((req: Request, _res: Response, next: NextFunction) => {
      // reason: test stub — the real middleware attaches a full PortalSession
      req.portalSession = {
        portalIdentityId: identityId,
        firmId: seed.firmId,
        activeClientId: seed.clientId,
      } as never;
      next();
    });
    a.use(
      '/profile',
      createPortalProfileRouter({
        db: harness.db,
        requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
      } as never),
    );
    await harness.db.execute(
      sql`UPDATE person SET sms_opt_out = true, sms_opt_out_source = 'inbound_stop' WHERE id = ${personId}`,
    );
    const r = await request(a).patch('/profile/contact-preferences').send({ smsOptOut: false });
    expect(r.status).toBe(200);
    let [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(false);
    expect(p!.smsConsentSource).toBe('portal');
    await harness.db.execute(
      sql`UPDATE person SET sms_consent_at = NULL, sms_consent_source = NULL WHERE id = ${personId}`,
    );
    const r2 = await request(a).patch('/profile/contact-preferences').send({ smsConsent: true });
    expect(r2.status).toBe(200);
    [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsConsentSource).toBe('portal');
    const prefs = await request(a).get('/profile/bulk-email-preference');
    expect(prefs.body.smsConsent).toBe(true);
  });
});
