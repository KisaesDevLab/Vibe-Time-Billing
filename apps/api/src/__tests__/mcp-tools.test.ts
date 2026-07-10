// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Expanded MCP tool catalog — read/write/reporting/automation. Verifies the
// new tools dispatch, are firm-scoped, and honor per-tool scope denial.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';

import { mcpTokens, recurringBillingPlans, engagements } from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createMcpRouter } from '../mcp/routes';
import { requireApiToken, hashToken } from '../auth/api-token';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function mcpApp(): express.Express {
  const a = express();
  a.use(requireApiToken(harness.db));
  a.use('/api/mcp', createMcpRouter({ db: harness.db }));
  return a;
}

async function makeToken(allowedTools: string[]): Promise<string> {
  const secret = 'tok-test';
  await harness.db.insert(mcpTokens).values({
    firmId: seed.firmId,
    name: 't',
    tokenHash: hashToken(secret),
    allowedTools,
    createdById: seed.appUserId,
  });
  return secret;
}

function call(secret: string, tool: string, args: Record<string, unknown> = {}): request.Test {
  return request(mcpApp())
    .post('/api/mcp/call')
    .set('Authorization', `Bearer ${secret}`)
    .send({ tool, args });
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('MCP expanded tools', () => {
  it('list_clients returns firm clients', async () => {
    const secret = await makeToken(['list_clients']);
    const res = await call(secret, 'list_clients');
    expect(res.status).toBe(200);
    expect(res.body.result.items.length).toBeGreaterThanOrEqual(1);
  });

  it('denies a tool not in the token scope', async () => {
    const secret = await makeToken(['list_clients']);
    const res = await call(secret, 'query_mrr');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('scope_denied');
  });

  it('query_mrr normalizes a SEMIANNUAL plan to /6', async () => {
    const secret = await makeToken(['query_mrr']);
    await harness.db.execute(sql`
      INSERT INTO recurring_billing_plan (engagement_id, frequency, amount_cents, next_run_date, status)
      VALUES (${seed.engagementId}, 'SEMIANNUAL', 600000, '2026-07-01', 'ACTIVE')`);
    const res = await call(secret, 'query_mrr');
    expect(res.status).toBe(200);
    expect(res.body.result.mrrCents).toBe(100000);
    expect(res.body.result.planCount).toBe(1);
  });

  it('pauses and resumes a recurring plan', async () => {
    const secret = await makeToken(['pause_recurring_plan', 'resume_recurring_plan']);
    const ins = await harness.db
      .insert(recurringBillingPlans)
      .values({
        engagementId: seed.engagementId,
        frequency: 'MONTHLY',
        amountCents: 50000,
        nextRunDate: '2026-07-01',
        status: 'ACTIVE',
      })
      .returning({ id: recurringBillingPlans.id });
    const planId = ins[0]!.id;
    const paused = await call(secret, 'pause_recurring_plan', { planId });
    expect(paused.status).toBe(200);
    expect(paused.body.result.status).toBe('PAUSED');
    const [row] = await harness.db
      .select()
      .from(recurringBillingPlans)
      .where(eq(recurringBillingPlans.id, planId));
    expect(row!.status).toBe('PAUSED');
    const resumed = await call(secret, 'resume_recurring_plan', { planId });
    expect(resumed.body.result.status).toBe('ACTIVE');
  });

  it('update_engagement changes status', async () => {
    const secret = await makeToken(['update_engagement']);
    const res = await call(secret, 'update_engagement', {
      engagementId: seed.engagementId,
      status: 'CLOSED',
    });
    expect(res.status).toBe(200);
    const [row] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, seed.engagementId));
    expect(row!.status).toBe('CLOSED');
  });
});
