// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Anthropic Claude provider implementation of @vibe/core/ai.AiProvider.
//
// Cost estimation uses Claude's posted token rates as of 2026-Q2; firms
// can override in firm_settings if Anthropic raises/lowers them.

import type { AiCompletionRequest, AiCompletionResult, AiProvider } from '@vibe/core/ai';

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string; // e.g. 'claude-opus-4-7'
  fetchImpl?: typeof fetch;
  /** Cents per 1M input tokens. Stripe-style integers. */
  inputCentsPerMTok?: number;
  /** Cents per 1M output tokens. */
  outputCentsPerMTok?: number;
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): AiProvider {
  const model = opts.model ?? 'claude-opus-4-7';
  const inputRate = opts.inputCentsPerMTok ?? 1500; // $15 per 1M input tok
  const outputRate = opts.outputCentsPerMTok ?? 7500; // $75 per 1M output tok
  const fetchImpl: typeof fetch =
    opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined) ?? notWired;

  return {
    id: 'anthropic',
    async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
      const body = {
        model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.2,
        system: req.systemPrompt,
        messages: [{ role: 'user', content: req.userPrompt }],
      };
      const res = await fetchImpl(CLAUDE_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        content?: { type: string; text: string }[];
        usage?: { input_tokens: number; output_tokens: number };
        error?: { message: string };
      };
      if (!res.ok) {
        throw new Error(json.error?.message ?? `anthropic ${res.status}`);
      }
      const text = (json.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const inputTokens = json.usage?.input_tokens ?? 0;
      const outputTokens = json.usage?.output_tokens ?? 0;
      const costEstimateCents =
        Math.round((inputTokens * inputRate) / 1_000_000) +
        Math.round((outputTokens * outputRate) / 1_000_000);
      return {
        text,
        usage: { inputTokens, outputTokens },
        providerId: 'anthropic',
        costEstimateCents,
      };
    },
  };
}

function notWired(): never {
  throw new Error('No fetch implementation provided to AnthropicProvider');
}
