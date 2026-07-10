// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Process Project printing: tax-year prefill, PDF render (no persistence,
// merges the staff-chosen dropdowns + client/engagement data), permission
// gate, and the HTML template.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import { engagements } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createProcessProjectRouter } from '../process-project/routes';
import { renderProcessProjectHtml } from '../pdf-templates/process-project';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let lastHtml = '';

const fakeRender = async (html: string): Promise<Buffer> => {
  lastHtml = html;
  return Buffer.from('%PDF-1.4 fake');
};

function app(roles: RoleSlug[] = ['admin']): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  a.use(
    '/api/staff/process-project',
    createProcessProjectRouter({
      db: harness.db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, roles]]),
      renderPdf: fakeRender,
    }),
  );
  return a;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  lastHtml = '';
  // Give the seeded engagement a period year + a partner (responsible lead).
  await harness.db
    .update(engagements)
    .set({ periodYear: 2025, partnerId: seed.appUserId })
    .where(sql`id = ${seed.engagementId}`);
});
afterEach(async () => {
  await harness.close();
});

describe('GET prefill', () => {
  it('returns the engagement period year as the tax year', async () => {
    const r = await request(app()).get(
      `/api/staff/process-project/engagement/${seed.engagementId}/prefill`,
    );
    expect(r.status).toBe(200);
    expect(r.body.taxYear).toBe('2025');
  });
  it('404s for an engagement outside the firm', async () => {
    const r = await request(app()).get(
      `/api/staff/process-project/engagement/00000000-0000-4000-8000-000000000999/prefill`,
    );
    expect(r.status).toBe(404);
  });
});

describe('POST /pdf', () => {
  it('renders the form inline with the chosen dropdowns + data (no persistence)', async () => {
    const r = await request(app()).post('/api/staff/process-project/pdf').send({
      engagementId: seed.engagementId,
      taxYear: '2025',
      delivery: 'E-Sign',
      documents: 'Scanned to Tax Folder',
      matching: 'Other See Notes',
      notes: 'Call before pickup',
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('inline');
    // The fake renderer captured the HTML; assert the merged fields.
    expect(lastHtml).toContain('PROCESS PROJECT');
    expect(lastHtml).toContain('Test Client Co'); // seeded client name
    expect(lastHtml).toContain('E-Sign');
    expect(lastHtml).toContain('Scanned to Tax Folder');
    expect(lastHtml).toContain('Other See Notes');
    expect(lastHtml).toContain('Call before pickup');
    expect(lastHtml).toContain('2025');
  });

  it('403s without engagement:read', async () => {
    const r = await request(app([]))
      .post('/api/staff/process-project/pdf')
      .send({ engagementId: seed.engagementId });
    expect(r.status).toBe(403);
  });
});

describe('renderProcessProjectHtml template', () => {
  it('puts CLIENT at the top and includes the key fields', () => {
    const html = renderProcessProjectHtml({
      clientName: 'Kurt W. Krueger',
      taxYear: '2025',
      period: 'Monthly',
      responsibleLead: 'Pat Partner',
      responsibleStaff: 'Mary Manager',
      delivery: 'Portal',
      documents: 'Portal Folder',
      matching: 'No Match Send to Client',
      notes: 'Handle with care',
      address: '1 Main St',
      contacts: [{ name: 'Kurt Krueger', email: 'k@x.com', home: null, mobile: '555' }],
    });
    // CLIENT appears before the PROCESS PROJECT title.
    expect(html.indexOf('clienthead')).toBeLessThan(html.indexOf('PROCESS PROJECT'));
    expect(html).toContain('Kurt W. Krueger');
    expect(html).toContain('Pat Partner');
    expect(html).toContain('Portal Folder');
    expect(html).toContain('No Match Send to Client');
    expect(html).toContain('Handle with care');
  });
});
