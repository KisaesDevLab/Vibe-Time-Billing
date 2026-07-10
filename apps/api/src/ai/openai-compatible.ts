// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// OpenAI-compatible provider (Phase 23 #4). Speaks the standard
// /v1/chat/completions wire format used by OpenAI itself plus most
// drop-in alternatives (Together, Groq, OpenRouter, vLLM, LM Studio,
// llama.cpp's server mode, etc.). The firm sets AI_OPENAI_BASE_URL +
// AI_OPENAI_API_KEY + AI_OPENAI_MODEL and picks 'openai_compatible' as
// the provider for any feature they want routed there.

import type { AiCompletionRequest, AiCompletionResult, AiProvider } from '@vibe/core/ai';

export interface OpenAiCompatibleOptions {
  baseUrl: string; // e.g. 'https://api.openai.com/v1' or 'http://localhost:8080/v1'
  apiKey?: string; // optional — many local servers don't need one
  model: string;
  // Token cost rate (cents per 1K input/output tokens). Defaults to 0
  // because local servers are free; the firm overrides for hosted use.
  costPer1kInputCents?: number;
  costPer1kOutputCents?: number;
  fetchImpl?: typeof fetch;
}

export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): AiProvider {
  const url = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl: typeof fetch =
    opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined) ?? notWired;
  const inputRate = opts.costPer1kInputCents ?? 0;
  const outputRate = opts.costPer1kOutputCents ?? 0;

  return {
    id: 'openai_compatible',
    async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
      const body = {
        model: opts.model,
        messages: [
          ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
          { role: 'user', content: req.userPrompt },
        ],
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 1024,
      };
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;
      const res = await fetchImpl(`${url}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(json.error?.message ?? `openai_compatible ${res.status}`);
      }
      const inputTokens = json.usage?.prompt_tokens ?? 0;
      const outputTokens = json.usage?.completion_tokens ?? 0;
      const costEstimateCents = Math.round(
        (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate,
      );
      return {
        text: json.choices?.[0]?.message?.content ?? '',
        usage: { inputTokens, outputTokens },
        providerId: 'openai_compatible',
        costEstimateCents,
      };
    },
  };
}

function notWired(): never {
  throw new Error('No fetch implementation provided to OpenAiCompatibleProvider');
}
