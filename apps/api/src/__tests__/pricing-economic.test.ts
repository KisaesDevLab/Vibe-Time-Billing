// SPDX-License-Identifier: Elastic-2.0
//
// PS Phase 4 — economic factor: manual, cached live, fallback, YoY parse (PS-21).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { blsYoY, refreshEconomicIndex, resolveEconomicFactor } from '../pricing/economic';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

const thisYear = new Date().getFullYear();
// A fake BLS response: 3.0% YoY (309 vs 300).
const fakeFetch = (async () =>
  ({
    ok: true,
    json: async () => ({
      Results: {
        series: [
          {
            data: [
              { year: String(thisYear), period: 'M03', value: '309.0' },
              { year: String(thisYear - 1), period: 'M03', value: '300.0' },
            ],
          },
        ],
      },
    }),
  }) as unknown as Response) as unknown as typeof fetch;

describe('economic factor', () => {
  it('blsYoY computes trailing-12-month % change + as-of', () => {
    const r = blsYoY([
      { year: String(thisYear), period: 'M03', value: '309.0' },
      { year: String(thisYear - 1), period: 'M03', value: '300.0' },
    ]);
    expect(r.valuePct).toBe(3);
    expect(r.asOf).toBe(`${thisYear}-03-01`);
  });

  it('MANUAL returns the firm percent, no network', async () => {
    const r = await resolveEconomicFactor(harness.db, {
      firmId: seed.firmId,
      source: 'MANUAL',
      manualPct: 4.5,
    });
    expect(r).toEqual({ pct: 4.5, source: 'MANUAL', asOf: null });
  });

  it('CPI with no cache degrades to MANUAL; after a refresh it resolves to the cached value', async () => {
    const before = await resolveEconomicFactor(harness.db, {
      firmId: seed.firmId,
      source: 'CPI',
      manualPct: 2,
    });
    expect(before).toEqual({ pct: 2, source: 'MANUAL', asOf: null });

    await refreshEconomicIndex(harness.db, {
      firmId: seed.firmId,
      source: 'CPI',
      fetchImpl: fakeFetch,
    });

    const after = await resolveEconomicFactor(harness.db, {
      firmId: seed.firmId,
      source: 'CPI',
      manualPct: 2,
    });
    expect(after.pct).toBe(3);
    expect(after.source).toBe('CPI');
    expect(after.asOf).toBe(`${thisYear}-03-01`);
  });
});
