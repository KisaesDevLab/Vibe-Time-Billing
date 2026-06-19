// SPDX-License-Identifier: Elastic-2.0
//
// Economic factor service (PS Phase 4). The factor is the trailing-12-month %
// change applied once, after the margin gross-up. Sources:
//   - MANUAL: the firm's annual %, no network.
//   - CPI / ECI: the latest cached economic_index row (refreshed by a worker /
//     admin "refresh now"); if none is cached, transparently degrade to MANUAL.
// Live values are fetched from the BLS public API (egress-gated upstream).

import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { economicIndexes } from '@vibe/db/schema';

export type EconomicSource = 'MANUAL' | 'CPI' | 'ECI';

export interface EconomicFactor {
  pct: number;
  source: EconomicSource;
  asOf: string | null;
}

// BLS series ids: CPI-U (all items, US city avg) and ECI (total comp, all
// civilian, not seasonally adjusted).
const SERIES: Record<'CPI' | 'ECI', string> = {
  CPI: 'CUUR0000SA0',
  ECI: 'CIU1010000000000A',
};

export async function resolveEconomicFactor(
  db: Database,
  opts: { firmId: string; source: EconomicSource; manualPct: number },
): Promise<EconomicFactor> {
  if (opts.source === 'MANUAL') return { pct: opts.manualPct, source: 'MANUAL', asOf: null };
  const [row] = await db
    .select()
    .from(economicIndexes)
    .where(and(eq(economicIndexes.firmId, opts.firmId), eq(economicIndexes.source, opts.source)))
    .orderBy(desc(economicIndexes.fetchedAt))
    .limit(1);
  if (row) return { pct: Number(row.valuePct), source: opts.source, asOf: row.asOfDate };
  // No cached live value yet → degrade to the firm's manual figure.
  return { pct: opts.manualPct, source: 'MANUAL', asOf: null };
}

interface BlsPoint {
  year: string;
  period: string; // 'M01'..'M12' (CPI) or 'Q01'..'Q04' (ECI)
  value: string;
}

/** Compute the trailing-12-month % change from a BLS data series. */
export function blsYoY(data: BlsPoint[]): { valuePct: number; asOf: string } {
  const pts = [...data].sort((a, b) =>
    a.year === b.year ? b.period.localeCompare(a.period) : Number(b.year) - Number(a.year),
  );
  const latest = pts[0];
  if (!latest) throw new Error('bls_no_data');
  const prior = pts.find(
    (p) => p.period === latest.period && Number(p.year) === Number(latest.year) - 1,
  );
  if (!prior) throw new Error('bls_no_prior');
  const v0 = Number(latest.value);
  const v1 = Number(prior.value);
  if (!(v1 > 0)) throw new Error('bls_bad_value');
  return {
    valuePct: Number((((v0 - v1) / v1) * 100).toFixed(3)),
    asOf: `${latest.year}-${latest.period.replace(/^[MQ]/, '').padStart(2, '0')}-01`,
  };
}

/** Fetch the latest YoY figure for a source from the BLS API. */
export async function fetchBlsYoY(
  source: 'CPI' | 'ECI',
  fetchImpl: typeof fetch = fetch,
): Promise<{ valuePct: number; asOf: string }> {
  const thisYear = new Date().getFullYear();
  const res = await fetchImpl('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seriesid: [SERIES[source]],
      startyear: String(thisYear - 1),
      endyear: String(thisYear),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`bls_http_${res.status}`);
  const json = (await res.json()) as { Results?: { series?: { data?: BlsPoint[] }[] } };
  const data = json.Results?.series?.[0]?.data ?? [];
  return blsYoY(data);
}

/** Fetch + cache the latest live figure for a firm. Throws on fetch failure. */
export async function refreshEconomicIndex(
  db: Database,
  opts: { firmId: string; source: 'CPI' | 'ECI'; fetchImpl?: typeof fetch },
): Promise<EconomicFactor> {
  const { valuePct, asOf } = await fetchBlsYoY(opts.source, opts.fetchImpl ?? fetch);
  await db.insert(economicIndexes).values({
    firmId: opts.firmId,
    source: opts.source,
    valuePct: valuePct.toFixed(3),
    asOfDate: asOf,
  });
  return { pct: valuePct, source: opts.source, asOf };
}
