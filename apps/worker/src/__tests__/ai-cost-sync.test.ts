// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A1 (MIG-8 cost recovery) — ai-cost-sync: pulls the router billing feed
// and replace-upserts client_ai_cost. Router mode only; unresolvable
// client refs are skipped (other Vibe apps' rows), foreign engagement
// refs degrade to NULL with in-memory pre-aggregation, fractional
// NUMERIC::text costs round once per row, and re-runs are idempotent.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '@vibe/db/schema';
import type { Database } from '@vibe/db';

import { runAiCostSync } from '../jobs/ai-cost-sync';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'db', 'migrations');
const log = pino({ level: 'silent' });

// Fixed clock → periods 202607 + 202608.
const NOW = new Date('2026-08-08T12:00:00Z');

let pglite: PGlite;
let db: Database;
let firmId: string;
let clientId: string;
let engagementId: string;

const ENV_KEYS = ['VIBE_AI_MODE', 'VIBE_AI_ROUTER_URL', 'VIBE_AI_TOKEN'] as const;
let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  // Snapshot once, before any test mutates the env — restoring a per-test
  // snapshot would re-apply the previous test's values after the suite.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  pglite = new PGlite();
  for (const f of readdirSync(migrationsDir)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    const cleaned = readFileSync(join(migrationsDir, f), 'utf8')
      .replace(/DO \$\$\s*BEGIN\s*IF NOT EXISTS[\s\S]*?END\s*\$\$;?/g, '-- skipped')
      .replace(/^(REVOKE|GRANT) .*$/gim, '-- skipped');
    await pglite.exec(cleaned);
  }
  db = drizzle(pglite, { schema }) as unknown as Database;
  const firm = await db.execute(sql`INSERT INTO firm (name) VALUES ('F') RETURNING id`);
  firmId = (firm as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const u = await db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${firmId}, 'a@test.example', 'A', 'A', 'B') RETURNING id`,
  );
  const staffId = (u as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const office = await db.execute(
    sql`INSERT INTO office (firm_id, name, timezone, is_default)
        VALUES (${firmId}, 'HQ', 'America/Chicago', true) RETURNING id`,
  );
  const officeId = (office as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const client = await db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${firmId}, 'Client Co', ${staffId}, ${officeId}) RETURNING id`,
  );
  clientId = (client as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const eng = await db.execute(
    sql`INSERT INTO engagement (client_id, name, fee_structure)
        VALUES (${clientId}, 'Eng', 'HOURLY') RETURNING id`,
  );
  engagementId = (eng as unknown as { rows: { id: string }[] }).rows[0]!.id;
});

afterAll(async () => {
  await pglite.close();
  for (const k of ENV_KEYS) {
    if (savedEnv?.[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  process.env['VIBE_AI_MODE'] = 'router';
  process.env['VIBE_AI_ROUTER_URL'] = 'http://router.test:8220';
  process.env['VIBE_AI_TOKEN'] = 'tok';
  await db.execute(sql`DELETE FROM client_ai_cost`);
});

type FeedItem = Record<string, unknown>;

/** Fake router: serves per-period feed items keyed by the period param. */
function feedFetch(byPeriod: Record<string, FeedItem[]>): typeof fetch {
  return (async (url: unknown) => {
    const u = new URL(String(url));
    expect(u.pathname).toBe('/v1/billing/usage');
    const period = u.searchParams.get('period')!;
    return new Response(JSON.stringify({ period, items: byPeriod[period] ?? [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function item(over: Partial<FeedItem>): FeedItem {
  return {
    clientRef: clientId,
    engagementRef: null,
    app: 'vibe-time-billing',
    taskClass: 'tb_invoice_narrative',
    requests: 4,
    promptTokens: 400,
    completionTokens: 100,
    costCents: '12',
    ...over,
  };
}

async function rows(): Promise<
  {
    period: string;
    client_id: string;
    engagement_id: string | null;
    app: string;
    task_class: string | null;
    requests: number;
    cost_cents: number;
  }[]
> {
  const r = await db.execute(
    sql`SELECT period, client_id, engagement_id, app, task_class, requests,
               prompt_tokens, completion_tokens, cost_cents
        FROM client_ai_cost ORDER BY period, app, task_class`,
  );
  return (r as unknown as { rows: never[] }).rows;
}

describe('runAiCostSync', () => {
  it('no-ops outside router mode', async () => {
    process.env['VIBE_AI_MODE'] = 'direct';
    const result = await runAiCostSync(db, log, NOW, feedFetch({}));
    expect(result).toEqual({ periods: [], upserted: 0, skippedItems: 0 });
    expect(await rows()).toHaveLength(0);
  });

  it('upserts feed rows and is idempotent on re-run (replace, not add)', async () => {
    const fetch1 = feedFetch({
      '202608': [item({ engagementRef: engagementId })],
      '202607': [item({ taskClass: 'timebill_support_chat', requests: 2, costCents: '0' })],
    });
    const first = await runAiCostSync(db, log, NOW, fetch1);
    expect(first.periods).toEqual(['202607', '202608']);
    expect(first.upserted).toBe(2);
    expect(first.skippedItems).toBe(0);

    // Same period re-synced with updated aggregates → values replaced.
    const fetch2 = feedFetch({
      '202608': [item({ engagementRef: engagementId, requests: 9, costCents: '31' })],
      '202607': [item({ taskClass: 'timebill_support_chat', requests: 2, costCents: '0' })],
    });
    await runAiCostSync(db, log, NOW, fetch2);

    const all = await rows();
    expect(all).toHaveLength(2);
    const aug = all.find((r) => r.period === '202608')!;
    expect(aug.requests).toBe(9);
    expect(Number(aug.cost_cents)).toBe(31);
    expect(aug.engagement_id).toBe(engagementId);
    expect(aug.client_id).toBe(clientId);
  });

  it('skips rows whose client_ref does not resolve locally', async () => {
    const result = await runAiCostSync(
      db,
      log,
      NOW,
      feedFetch({
        '202608': [
          item({}),
          // Another Vibe app's client namespace — not a local client uuid.
          item({ clientRef: 'v1099:payee:42', app: 'vibe-1099' }),
          // Uuid-shaped but unknown.
          item({ clientRef: '00000000-0000-4000-8000-000000000000', app: 'vibe-mybooks' }),
        ],
      }),
    );
    expect(result.upserted).toBe(1);
    expect(result.skippedItems).toBe(2);
    expect(await rows()).toHaveLength(1);
  });

  it('degrades a foreign engagement_ref to NULL and pre-aggregates the collision', async () => {
    const result = await runAiCostSync(
      db,
      log,
      NOW,
      feedFetch({
        '202608': [
          // Engagement that doesn't exist → NULL dimension…
          item({
            engagementRef: '00000000-0000-4000-8000-00000000dead',
            requests: 3,
            costCents: '5',
          }),
          // …colliding with the already-NULL row on the natural key: must sum, not clobber.
          item({ requests: 4, costCents: '7' }),
        ],
      }),
    );
    expect(result.upserted).toBe(1);
    expect(result.skippedItems).toBe(0);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.engagement_id).toBeNull();
    expect(all[0]!.requests).toBe(7);
    expect(Number(all[0]!.cost_cents)).toBe(12);
  });

  it('rounds fractional NUMERIC::text costs once per aggregated row', async () => {
    await runAiCostSync(
      db,
      log,
      NOW,
      feedFetch({
        '202608': [item({ costCents: '12.5' }), item({ costCents: '0.4', requests: 1 })],
      }),
    );
    const all = await rows();
    expect(all).toHaveLength(1);
    // Sum exact then round once: 12.5 + 0.4 = 12.9 → 13. (Rounding each
    // item first would truncate sub-cent rows to 0 and drift the total.)
    expect(Number(all[0]!.cost_cents)).toBe(13);
  });
});
