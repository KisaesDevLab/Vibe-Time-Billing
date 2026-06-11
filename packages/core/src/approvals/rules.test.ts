// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect } from 'vitest';

import { evaluate, type ApprovalRule } from './rules';

const partnerThresholdRule: ApprovalRule = {
  id: 'r1',
  entityType: 'ADJUSTMENT',
  match: 'over_threshold',
  thresholdCents: 100000, // Q27 default
  exemptRoles: ['PARTNER', 'ADMIN'],
  approverResolver: 'partner_in_charge',
};

const reasonRule: ApprovalRule = {
  id: 'r2',
  entityType: 'ADJUSTMENT',
  match: 'reason_match',
  reasonCodeLabels: ['Estimating error'],
  approverResolver: 'firm_admin',
};

describe('approval evaluate', () => {
  it('passes through small adjustments', () => {
    const d = evaluate({
      context: {
        entityType: 'ADJUSTMENT',
        entityId: 'a1',
        requesterRole: 'MANAGER',
        amountCents: -50000,
      },
      rules: [partnerThresholdRule],
    });
    expect(d.requiresApproval).toBe(false);
  });

  it('requires approval for adjustments over threshold (Q27)', () => {
    const d = evaluate({
      context: {
        entityType: 'ADJUSTMENT',
        entityId: 'a1',
        requesterRole: 'MANAGER',
        amountCents: -150000,
        partnerInChargeId: 'p1',
      },
      rules: [partnerThresholdRule],
    });
    expect(d.requiresApproval).toBe(true);
    expect(d.approverAppUserId).toBe('p1');
  });

  it('exempts partners from their own approval', () => {
    const d = evaluate({
      context: {
        entityType: 'ADJUSTMENT',
        entityId: 'a1',
        requesterRole: 'PARTNER',
        amountCents: -150000,
      },
      rules: [partnerThresholdRule],
    });
    expect(d.requiresApproval).toBe(false);
  });

  it('reason-code rule triggers regardless of amount', () => {
    const d = evaluate({
      context: {
        entityType: 'ADJUSTMENT',
        entityId: 'a1',
        requesterRole: 'STAFF',
        amountCents: -5000,
        reasonCodeLabel: 'Estimating error',
      },
      rules: [reasonRule],
    });
    expect(d.requiresApproval).toBe(true);
  });

  it('first matching rule wins (eval is short-circuit)', () => {
    const d = evaluate({
      context: {
        entityType: 'ADJUSTMENT',
        entityId: 'a1',
        requesterRole: 'STAFF',
        amountCents: -150000,
        reasonCodeLabel: 'Estimating error',
        partnerInChargeId: 'p1',
      },
      rules: [partnerThresholdRule, reasonRule],
    });
    expect(d.requiresApproval).toBe(true);
    expect(d.rule?.id).toBe('r1');
  });

  it('ignores rules with mismatched entity type', () => {
    const d = evaluate({
      context: {
        entityType: 'INVOICE',
        entityId: 'i1',
        requesterRole: 'STAFF',
      },
      rules: [partnerThresholdRule],
    });
    expect(d.requiresApproval).toBe(false);
  });
});
