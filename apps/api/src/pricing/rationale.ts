// SPDX-License-Identifier: Elastic-2.0
//
// Rationale generation (PS Phase 7). The LLM writes prose ONLY — it is given the
// figures and told not to change them. There is always a deterministic templated
// fallback, so a number + an explanation appear even with no AI / no budget /
// local-only. The injectable `aiComplete` keeps this module pure + testable; the
// route supplies the real provider call (with budget + logging).

import type { PriceResult } from '@vibe/core/pricing';

import type { EconomicFactor } from './economic';
import type { SanitySignals } from './tier2';

export interface RationaleContext {
  returnType: string | null;
  cohortSize: number;
  price: PriceResult;
  economic: EconomicFactor;
  signals: SanitySignals;
}

export type AiComplete = (systemPrompt: string, userPrompt: string) => Promise<string>;

const money = (cents: number): string => `$${Math.round(cents / 100).toLocaleString()}`;

export function templateRationale(ctx: RationaleContext): string {
  const p = ctx.price;
  const kind = ctx.returnType ? `${ctx.returnType} engagement` : 'engagement';
  const head = `Suggested ${money(p.lowCents)}–${money(p.highCents)} for this ${kind}.`;

  const body =
    p.mode === 'PRIOR_FEE_FALLBACK'
      ? `The cohort of similar engagements was too small (${ctx.cohortSize}) for a reliable cost build, so this is the prior fee adjusted by ${ctx.economic.pct}% (${ctx.economic.source}${ctx.economic.asOf ? `, as of ${ctx.economic.asOf}` : ''}). Confidence is ${p.confidence}; treat as a starting point.`
      : `Built bottom-up from ${ctx.cohortSize} similar engagements: burdened delivery cost ${money(p.costBaseCents)}, grossed up to a ${p.targetMarginPct}% gross margin (${money(p.grossedUpCents)}), then adjusted ${ctx.economic.pct}% for ${ctx.economic.source}${ctx.economic.asOf ? ` (as of ${ctx.economic.asOf})` : ''}. Confidence: ${p.confidence}.`;

  const signals = ctx.signals.signals.map((s) => s.text).join(' ');
  return [head, body, signals].filter(Boolean).join(' ');
}

const SYSTEM_PROMPT =
  'You are a CPA pricing assistant. Given structured pricing inputs, write a 2–4 sentence ' +
  'plain-English rationale a partner could show a client to justify the fee. Use ONLY the ' +
  'figures provided — never invent, recompute, or change any number or the range. Be concrete ' +
  'and professional. Output the rationale text only, no preface or markdown.';

export async function buildRationale(
  ctx: RationaleContext,
  aiComplete?: AiComplete | null,
): Promise<{ text: string; source: 'AI' | 'TEMPLATE' }> {
  const template = templateRationale(ctx);
  if (!aiComplete) return { text: template, source: 'TEMPLATE' };
  try {
    const userPrompt = JSON.stringify({
      returnType: ctx.returnType,
      cohortSize: ctx.cohortSize,
      suggestedRange: { low: money(ctx.price.lowCents), high: money(ctx.price.highCents) },
      burdenedCost: money(ctx.price.costBaseCents),
      targetMarginPct: ctx.price.targetMarginPct,
      economicFactorPct: ctx.economic.pct,
      economicSource: ctx.economic.source,
      confidence: ctx.price.confidence,
      mode: ctx.price.mode,
      signals: ctx.signals.signals.map((s) => s.text),
    });
    const text = (await aiComplete(SYSTEM_PROMPT, userPrompt)).trim();
    return text ? { text, source: 'AI' } : { text: template, source: 'TEMPLATE' };
  } catch {
    // PS-22 — any AI failure degrades to the templated rationale.
    return { text: template, source: 'TEMPLATE' };
  }
}
