// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Local Ollama provider. Free at the dollar layer — costEstimateCents
// always 0. The hardware-adaptive model picker lives at install
// (ops/scripts/install-detect-llm.sh); this client uses whatever
// AI_LOCAL_MODEL the firm has installed.

import type { AiCompletionRequest, AiCompletionResult, AiProvider } from '@vibe/core/ai';

export interface OllamaProviderOptions {
  url?: string; // default http://localhost:11434
  model: string; // e.g. 'qwen3:8b-q4_K_M'
  fetchImpl?: typeof fetch;
}

export function createOllamaProvider(opts: OllamaProviderOptions): AiProvider {
  const url = (opts.url ?? 'http://localhost:11434').replace(/\/+$/, '');
  const fetchImpl: typeof fetch =
    opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined) ?? notWired;

  return {
    id: 'ollama',
    async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
      const body = {
        model: opts.model,
        stream: false,
        options: {
          temperature: req.temperature ?? 0.2,
          num_predict: req.maxTokens ?? 1024,
        },
        messages: [
          ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
          { role: 'user', content: req.userPrompt },
        ],
      };
      const res = await fetchImpl(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        message?: { content: string };
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `ollama ${res.status}`);
      return {
        text: json.message?.content ?? '',
        usage: {
          inputTokens: json.prompt_eval_count ?? 0,
          outputTokens: json.eval_count ?? 0,
        },
        providerId: 'ollama',
        costEstimateCents: 0,
      };
    },
  };
}

function notWired(): never {
  throw new Error('No fetch implementation provided to OllamaProvider');
}
