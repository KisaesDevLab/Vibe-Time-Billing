// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// AI provider abstraction. Three implementations: Anthropic Claude API,
// Ollama / llama.cpp (local), OpenAI-compatible. Routing prefers local
// per Q15; cloud fallback per-feature toggle.

export type AiProviderId = 'anthropic' | 'ollama' | 'openai_compatible';

export interface AiCompletionRequest {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  providerId: AiProviderId;
  costEstimateCents: number;
}

export interface AiProvider {
  id: AiProviderId;
  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;
}

export interface CostBudget {
  monthlyBudgetCents: number;
  warnThresholdPct: number;
  spentCents: number;
}

export type BudgetCheck =
  | { kind: 'ok' }
  | { kind: 'warn'; remainingCents: number }
  | { kind: 'exhausted'; resetsOn: string };

export function checkBudget(budget: CostBudget, now: Date = new Date()): BudgetCheck {
  if (budget.spentCents >= budget.monthlyBudgetCents) {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { kind: 'exhausted', resetsOn: next.toISOString().slice(0, 10) };
  }
  const pct = (budget.spentCents / budget.monthlyBudgetCents) * 100;
  if (pct >= budget.warnThresholdPct) {
    return { kind: 'warn', remainingCents: budget.monthlyBudgetCents - budget.spentCents };
  }
  return { kind: 'ok' };
}
