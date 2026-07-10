// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { matchRule, type SignaturePrintRule } from './signature-print';

function rule(p: Partial<SignaturePrintRule>): SignaturePrintRule {
  return {
    id: p.id ?? 'r',
    firmId: 'f',
    name: p.name ?? 'rule',
    priority: p.priority ?? 100,
    enabled: true,
    formCodes: p.formCodes ?? [],
    engagementTypeIds: p.engagementTypeIds ?? [],
    templateSource: p.templateSource ?? 'builtin',
    gatewayTemplateId: p.gatewayTemplateId ?? null,
    printerMode: p.printerMode ?? 'specific',
    printerId: p.printerId ?? 1,
    copies: p.copies ?? 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as SignaturePrintRule;
}

describe('matchRule', () => {
  it('empty filters match anything', () => {
    const r = rule({ id: 'any' });
    expect(matchRule([r], { formCode: '1040', engagementTypeId: 'x' })?.id).toBe('any');
    expect(matchRule([r], { formCode: null, engagementTypeId: null })?.id).toBe('any');
  });

  it('matches by form code (case-insensitive) and skips non-matches', () => {
    const r = rule({ id: 'f1040', formCodes: ['1040'] });
    expect(matchRule([r], { formCode: '1040', engagementTypeId: null })?.id).toBe('f1040');
    expect(matchRule([r], { formCode: 'p1040', engagementTypeId: null })).toBeNull();
    const rcase = rule({ id: 'biz', formCodes: ['1120-s'] });
    expect(matchRule([rcase], { formCode: '1120-S', engagementTypeId: null })?.id).toBe('biz');
  });

  it('requires both form code AND engagement type when both set', () => {
    const r = rule({ id: 'both', formCodes: ['1040'], engagementTypeIds: ['eng1'] });
    expect(matchRule([r], { formCode: '1040', engagementTypeId: 'eng1' })?.id).toBe('both');
    expect(matchRule([r], { formCode: '1040', engagementTypeId: 'eng2' })).toBeNull();
    expect(matchRule([r], { formCode: '1065', engagementTypeId: 'eng1' })).toBeNull();
  });

  it('returns the first rule in the given order (priority handled by caller)', () => {
    const a = rule({ id: 'a', formCodes: ['1040'] });
    const b = rule({ id: 'b', formCodes: [] });
    expect(matchRule([a, b], { formCode: '1040', engagementTypeId: null })?.id).toBe('a');
    expect(matchRule([b, a], { formCode: '1040', engagementTypeId: null })?.id).toBe('b');
  });

  it('no match returns null', () => {
    const r = rule({ formCodes: ['1040'] });
    expect(matchRule([r], { formCode: '1065', engagementTypeId: null })).toBeNull();
    expect(matchRule([], { formCode: '1040', engagementTypeId: null })).toBeNull();
  });
});
