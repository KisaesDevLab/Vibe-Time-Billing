// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The 'yyyymm' UTC month key is the cross-component contract for
// client_ai_cost.period: the worker sync job writes it, the
// /api/ai/client-costs endpoint queries it, and the admin AI-usage card
// builds its period selector from it. All three must agree exactly —
// lookups are string equality — so the format lives here once.

/** UTC month key, e.g. 2026-08-12 → '202608'. */
export function aiCostPeriod(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last `count` UTC month keys, newest first. */
export function recentAiCostPeriods(count: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(aiCostPeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}
