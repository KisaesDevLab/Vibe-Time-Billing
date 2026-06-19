// SPDX-License-Identifier: Elastic-2.0
//
// The AI report-params registry validates and constrains anything the model
// produces before it becomes a saved report's params. These pin the contract.

import { describe, expect, it } from 'vitest';

import { validateReportParams, paramSpecPrompt, extractJsonObject } from '../ai/report-params';

describe('AI report-params registry', () => {
  it('accepts valid realization params and rejects bad enum / unknown keys', () => {
    expect(validateReportParams('realization', { dimension: 'timekeeper' })).toEqual({
      ok: true,
      params: { dimension: 'timekeeper' },
    });
    expect(validateReportParams('realization', { dimension: 'bogus' }).ok).toBe(false);
    expect(validateReportParams('realization', { nope: 1 }).ok).toBe(false);
  });

  it('no-param kinds only accept {}', () => {
    expect(validateReportParams('mrr', {})).toEqual({ ok: true, params: {} });
    expect(validateReportParams('mrr', { days: 30 }).ok).toBe(false);
  });

  it('does not coerce — numbers must be numbers and respect bounds', () => {
    expect(validateReportParams('dso', { days: 90 }).ok).toBe(true);
    expect(validateReportParams('dso', { days: '90' }).ok).toBe(false);
    expect(validateReportParams('dso', { days: 10 }).ok).toBe(false); // below min 30
  });

  it('unknown report kind is rejected', () => {
    expect(validateReportParams('does-not-exist', {}).ok).toBe(false);
    expect(paramSpecPrompt('does-not-exist')).toBeNull();
  });

  it('extracts JSON from fenced / noisy model output', () => {
    expect(extractJsonObject('```json\n{"days": 90}\n```')).toEqual({ days: 90 });
    expect(extractJsonObject('Here you go: {"dimension":"client"} hope that helps')).toEqual({
      dimension: 'client',
    });
    expect(extractJsonObject('no json here')).toBeNull();
  });
});
