// SPDX-License-Identifier: Elastic-2.0
//
// Auto-matching a tax return to the client's engagement: formCode → returnType
// mapping, and the single-unambiguous-match rule (0/2+ → null for manual link).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { engagements } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { formCodeToReturnType, matchEngagementForReturn } from '../tax-returns/engagement-match';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

async function addEngagement(opts: {
  returnType: string | null;
  taxYear: number | null;
  status?: string;
  workflowState?: string;
  name?: string;
}): Promise<string> {
  const [row] = await harness.db
    .insert(engagements)
    .values({
      clientId: seed.clientId,
      name: opts.name ?? `${opts.returnType ?? 'eng'} ${opts.taxYear ?? ''}`,
      status: (opts.status ?? 'ACTIVE') as 'ACTIVE',
      feeStructure: 'FIXED_FEE',
      workflowState: opts.workflowState ?? 'NO_STATUS',
      returnType: opts.returnType,
      taxYear: opts.taxYear,
    })
    .returning({ id: engagements.id });
  return row!.id;
}

describe('formCodeToReturnType', () => {
  it('folds form codes into the six engagement return types', () => {
    expect(formCodeToReturnType('1040')).toBe('1040');
    expect(formCodeToReturnType('1040-SR')).toBe('1040');
    expect(formCodeToReturnType('1120-S')).toBe('1120S');
    expect(formCodeToReturnType('1120')).toBe('1120');
    expect(formCodeToReturnType('1065')).toBe('1065');
    expect(formCodeToReturnType('990-PF')).toBe('990');
    expect(formCodeToReturnType('ST-100')).toBeNull();
    expect(formCodeToReturnType('')).toBeNull();
  });
});

describe('matchEngagementForReturn', () => {
  it('links a single ACTIVE engagement of the same returnType + taxYear', async () => {
    const id = await addEngagement({ returnType: '1040', taxYear: 2024 });
    const match = await matchEngagementForReturn(harness.db, {
      clientId: seed.clientId,
      formCode: '1040',
      taxYear: 2024,
    });
    expect(match).toBe(id);
  });

  it('returns null when nothing matches the year', async () => {
    await addEngagement({ returnType: '1040', taxYear: 2023 });
    const match = await matchEngagementForReturn(harness.db, {
      clientId: seed.clientId,
      formCode: '1040',
      taxYear: 2024,
    });
    expect(match).toBeNull();
  });

  it('returns null when ambiguous (two candidates)', async () => {
    await addEngagement({ returnType: '1040', taxYear: 2024, name: 'A' });
    await addEngagement({ returnType: '1040', taxYear: 2024, name: 'B' });
    const match = await matchEngagementForReturn(harness.db, {
      clientId: seed.clientId,
      formCode: '1040',
      taxYear: 2024,
    });
    expect(match).toBeNull();
  });

  it('ignores workflow-terminal and non-ACTIVE engagements', async () => {
    await addEngagement({ returnType: '1040', taxYear: 2024, workflowState: 'COMPLETED' });
    await addEngagement({ returnType: '1040', taxYear: 2024, status: 'CLOSED' });
    const live = await addEngagement({ returnType: '1040', taxYear: 2024 });
    const match = await matchEngagementForReturn(harness.db, {
      clientId: seed.clientId,
      formCode: '1040',
      taxYear: 2024,
    });
    expect(match).toBe(live);
  });
});
