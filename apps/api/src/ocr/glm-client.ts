// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Thin HTTP client for the firm's local GLM-OCR endpoint (an
// OpenAI-compatible /v1/chat/completions server on the on-prem workstation).
// The base URL is a firm-configured trusted LAN address, so — like
// print-gateway/client.ts — no SSRF guard is applied. Screenshots are sent
// as an inline data: image and never leave the LAN.

import { ExtractedSchema, SCHEMA_PROMPT, type ExtractedFields } from './map-to-client';

export interface GlmOcrConfig {
  baseUrl: string; // e.g. 'http://192.168.68.105:8082' (with or without /v1)
  model: string; // must be 'glm-ocr' for the reference server
  apiKey?: string; // optional bearer; the LAN llama-server is unauthenticated
  timeoutMs?: number;
}

export interface GlmOcrResult {
  extracted: ExtractedFields;
  rawContent: string;
  usage?: { inputTokens: number; outputTokens: number };
}

type FetchImpl = typeof fetch;

const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_MS = [500, 1000, 2000];

function completionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

// Pull the JSON object out of the model's reply: strip ```json fences and any
// prose surrounding the object. GLM-OCR can vary whitespace and occasionally
// emit fences, so we locate the outermost { … } rather than trust the shape.
export function extractJsonObject(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? content).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * OCR an UltraTax General Information screen (PNG, base64 without the data:
 * prefix) into validated ExtractedFields. Retries 3× on 5xx with 500/1000/
 * 2000ms backoff, mirroring the sibling extractor's GlmOcrClient.
 */
export async function extractGeneralInfo(
  cfg: GlmOcrConfig,
  imageBase64: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<GlmOcrResult> {
  const f = opts.fetchImpl ?? fetch;
  const url = completionsUrl(cfg.baseUrl);
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const body = JSON.stringify({
    model: cfg.model,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          { type: 'text', text: SCHEMA_PROMPT },
        ],
      },
    ],
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const res = await withTimeout(timeoutMs, (signal) =>
        f(url, { method: 'POST', headers, body, signal }),
      );
      if (res.status >= 500 && attempt < RETRY_BACKOFF_MS.length) {
        lastErr = new Error(`glm_ocr_${res.status}`);
        await sleep(RETRY_BACKOFF_MS[attempt]!);
        continue;
      }
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        throw new Error(`glm_ocr_failed_${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const rawContent = json.choices?.[0]?.message?.content ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonObject(rawContent));
      } catch {
        throw new Error('glm_ocr_invalid_json');
      }
      const result = ExtractedSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error('glm_ocr_schema_mismatch');
      }
      return {
        extracted: result.data,
        rawContent,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    } catch (err) {
      // Retry only the transient 5xx path (handled above via continue); a
      // parse/schema/timeout error on the final attempt propagates.
      lastErr = err;
      if (attempt >= RETRY_BACKOFF_MS.length) break;
      // Non-5xx errors (bad JSON, abort) shouldn't spin the full retry loop.
      if (err instanceof Error && err.message.startsWith('glm_ocr_') && err.name !== 'AbortError') {
        break;
      }
      await sleep(RETRY_BACKOFF_MS[attempt]!);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('glm_ocr_failed');
}

export interface OcrClient {
  extract(imageBase64: string): Promise<GlmOcrResult>;
  model: string;
}

// Bound at boot in server.ts when GLM_OCR_URL is set; injected through
// AppDeps so the route stays unit-testable with a stub.
export function createOcrClient(cfg: GlmOcrConfig): OcrClient {
  return {
    model: cfg.model,
    extract: (imageBase64: string) => extractGeneralInfo(cfg, imageBase64),
  };
}
