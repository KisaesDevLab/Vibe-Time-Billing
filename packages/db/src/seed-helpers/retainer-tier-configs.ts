// SPDX-License-Identifier: Elastic-2.0
//
// R0.3 — Default retainer tier configs (Vibe T&B Retainer Addendum).
//
// Inserts two tiers (TIER_1 + TIER_2) per return type for the given
// firm, plus a firm_retainer_settings row if absent. Default eligibility
// is intentionally empty — operator picks work codes via the admin
// settings page (R1). Defaults are conservative starting values; firms
// are expected to tune them.
//
// Idempotent: ON CONFLICT DO NOTHING on the (firm_id, return_type, tier)
// unique index. Existing operator-tuned rows survive re-runs.

import { sql } from 'drizzle-orm';
import type { PgDatabase, QueryResultHKT } from 'drizzle-orm/pg-core';

import { firmRetainerSettings, retainerTierConfigs } from '../schema/retainers';

interface TierDefault {
  returnType: '1040' | '1065' | '1120' | '1120S' | '1041' | '990';
  tier: 'TIER_1' | 'TIER_2';
  name: string;
  hours: string;
  baseFeeCents: number;
  pctOfPrepFeeBps: number;
}

// Conservative starting values — firms should tune in admin settings.
// pct stored as basis points (1000 = 10%, 2500 = 25%).
const DEFAULTS: ReadonlyArray<TierDefault> = [
  // 1040 — individual returns
  {
    returnType: '1040',
    tier: 'TIER_1',
    name: 'Standard Coverage',
    hours: '5',
    baseFeeCents: 25000,
    pctOfPrepFeeBps: 1000,
  },
  {
    returnType: '1040',
    tier: 'TIER_2',
    name: 'Premium Coverage',
    hours: '12',
    baseFeeCents: 50000,
    pctOfPrepFeeBps: 2500,
  },
  // 1065 — partnership
  {
    returnType: '1065',
    tier: 'TIER_1',
    name: 'Standard Coverage',
    hours: '8',
    baseFeeCents: 50000,
    pctOfPrepFeeBps: 1500,
  },
  {
    returnType: '1065',
    tier: 'TIER_2',
    name: 'Premium Coverage',
    hours: '20',
    baseFeeCents: 100000,
    pctOfPrepFeeBps: 3000,
  },
  // 1120 — C-corp
  {
    returnType: '1120',
    tier: 'TIER_1',
    name: 'Standard Coverage',
    hours: '10',
    baseFeeCents: 75000,
    pctOfPrepFeeBps: 1500,
  },
  {
    returnType: '1120',
    tier: 'TIER_2',
    name: 'Premium Coverage',
    hours: '25',
    baseFeeCents: 150000,
    pctOfPrepFeeBps: 3000,
  },
  // 1120S — S-corp
  {
    returnType: '1120S',
    tier: 'TIER_1',
    name: 'Standard Coverage',
    hours: '8',
    baseFeeCents: 50000,
    pctOfPrepFeeBps: 1500,
  },
  {
    returnType: '1120S',
    tier: 'TIER_2',
    name: 'Premium Coverage',
    hours: '20',
    baseFeeCents: 100000,
    pctOfPrepFeeBps: 3000,
  },
  // 1041 — fiduciary
  {
    returnType: '1041',
    tier: 'TIER_1',
    name: 'Standard Coverage',
    hours: '6',
    baseFeeCents: 40000,
    pctOfPrepFeeBps: 1500,
  },
  {
    returnType: '1041',
    tier: 'TIER_2',
    name: 'Premium Coverage',
    hours: '15',
    baseFeeCents: 80000,
    pctOfPrepFeeBps: 2500,
  },
  // 990 — nonprofit
  {
    returnType: '990',
    tier: 'TIER_1',
    name: 'Standard Coverage',
    hours: '10',
    baseFeeCents: 60000,
    pctOfPrepFeeBps: 1500,
  },
  {
    returnType: '990',
    tier: 'TIER_2',
    name: 'Premium Coverage',
    hours: '25',
    baseFeeCents: 120000,
    pctOfPrepFeeBps: 3000,
  },
];

// reason: drizzle-orm's per-schema Tx types are not assignment-compatible
// across call sites; widening to the base PgDatabase keeps the helper
// usable from both seed scripts and the firm-creation transaction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgDatabase<QueryResultHKT, any, any>;

/**
 * Seed default retainer tier configs for a firm + ensure a
 * firm_retainer_settings row exists. Idempotent on re-run: existing
 * operator overrides survive (ON CONFLICT DO NOTHING).
 *
 * Returns the number of newly-inserted tier_config rows.
 */
export async function seedRetainerTierConfigs(tx: Tx, firmId: string): Promise<number> {
  // Ensure firm_retainer_settings exists (idempotent).
  await tx
    .insert(firmRetainerSettings)
    .values({ firmId })
    .onConflictDoNothing({ target: firmRetainerSettings.firmId });

  let inserted = 0;
  for (const def of DEFAULTS) {
    const result = await tx
      .insert(retainerTierConfigs)
      .values({
        firmId,
        returnType: def.returnType,
        tier: def.tier,
        name: def.name,
        hours: def.hours,
        baseFeeCents: def.baseFeeCents,
        pctOfPrepFeeBps: def.pctOfPrepFeeBps,
      })
      .onConflictDoNothing({
        target: [
          retainerTierConfigs.firmId,
          retainerTierConfigs.returnType,
          retainerTierConfigs.tier,
        ],
      })
      .returning({ id: retainerTierConfigs.id });
    if (result.length > 0) inserted++;
  }
  // Reference sql import so future raw-SQL uses don't introduce a churn.
  void sql;
  return inserted;
}

export const RETAINER_TIER_DEFAULTS = DEFAULTS;
