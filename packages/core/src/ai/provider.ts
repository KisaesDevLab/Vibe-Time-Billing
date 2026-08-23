// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// AI provider abstraction. Three implementations: Anthropic Claude API,
// Ollama / llama.cpp (local), OpenAI-compatible. Routing prefers local
// per Q15; cloud fallback per-feature toggle.

export type AiProviderId = 'anthropic' | 'ollama' | 'openai_compatible' | 'vibe_router';

/** 0223 — inline image handed to a vision-capable model (data: URL). */
export interface AiAttachment {
  kind: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataUrl: string;
}

export interface AiCompletionRequest {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * 0223 — router-only extras. `attachments` become image parts of the user
   * message; `jsonSchema` requests structured output (the provider returns
   * the JSON object serialised in `text`). Direct providers ignore both —
   * features that need them are gated to router mode.
   */
  attachments?: AiAttachment[];
  jsonSchema?: { name: string; schema: unknown; strict?: boolean };
  /**
   * Router-mode attribution (MIG-8/A1): ledger dimensions for the Vibe AI
   * Router. Direct providers ignore all three. These ride ONLY as request
   * headers (x-vibe-user / x-vibe-client / x-vibe-engagement) — never in
   * prompt text. userId is the internal `app_user` UUID (per-user budgets
   * key on it; portal callers send null); clientRef/engagementRef are the
   * internal client/engagement UUIDs that tie spend to a client for cost
   * recovery via the router's billing feed.
   */
  userId?: string | null;
  clientRef?: string | null;
  engagementRef?: string | null;
}

export interface AiCompletionResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  providerId: AiProviderId;
  costEstimateCents: number;
  /** Model that actually served — router mode, where policy picks it. */
  model?: string;
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
