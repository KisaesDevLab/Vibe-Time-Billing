// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// MIG-8 (router-option addendum, Q-063/Q-064) — Vibe AI Router driver.
//
// When VIBE_AI_MODE=router, pickProvider() short-circuits to this provider for
// every AI feature: the app stops choosing providers and models — the task
// class is the only knob, and router policy decides model, fallback, budgets,
// scrubbing, and cost. The app-side egress gate, firm provider credentials,
// and cost budget become inert (the router console owns all three). `direct`
// (default) leaves the existing Anthropic/Ollama/OpenAI-compat path untouched
// for standalone single-install deployments.
//
// NO silent cross-mode fallback: a router outage surfaces as a failed AI call
// (features already degrade gracefully); quietly retrying against a direct
// provider would ship the prompt around the router's scrubber and ledger.
//
// Attribution headers (A1): x-vibe-user carries the internal `app_user` UUID
// (the router's per-user budgets key on it; portal callers send none);
// x-vibe-client / x-vibe-engagement carry internal client/engagement UUIDs
// for the billing feed. Attribution never enters prompt text.

import {
  VibeAiClient,
  VibeAiError,
  type ChatMessage,
  type ImagePart,
  type TaskClassDeclaration,
  type TextPart,
} from '@kisaes/vibe-ai-client';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from '@vibe/core/ai';

import { appVersion } from '../version';
import { getAiRuntime, onAiRuntimeChange } from './ai-runtime';

// ── mode flag ────────────────────────────────────────────────────────────

export type AiMode = 'direct' | 'router';

/**
 * Effective mode. 0222: resolved from firm_config (Admin → AI settings)
 * with the VIBE_AI_MODE env var as the appliance default — see
 * ai-runtime.ts. Synchronous because pickProvider() is.
 */
export function aiMode(): AiMode {
  return getAiRuntime().mode;
}

function routerCreds(): { baseUrl: string; token: string } {
  const rt = getAiRuntime();
  return { baseUrl: rt.routerUrl ?? '', token: rt.routerToken ?? '' };
}

// ── task classes ─────────────────────────────────────────────────────────

export const TIMEBILL_TASK_CLASSES = {
  /** Billing-text drafting over client billing data (default pack, cloud_deidentified) */
  INVOICE_NARRATIVE: 'tb_invoice_narrative',
  /** Practice-metric narratives, NL query translation, pricing (NEW — starts local_only) */
  PRACTICE_ANALYTICS: 'timebill_practice_analytics',
  /** KB-grounded support chat, staff + portal (NEW — starts local_only) */
  SUPPORT_CHAT: 'timebill_support_chat',
  /** 0223 — filename fields from a document's first pages (vision +
   *  structured output; NEW — starts local_only, operator widens) */
  FILE_NAMING: 'timebill_file_naming',
} as const;

/**
 * pickProvider() feature string → task class. Billing-text features ride the
 * reviewed pack class; everything analytic goes to the new practice-analytics
 * class; KB chat (staff + portal) gets its own. client_intake_ocr is GLM-OCR
 * and never passes through an AiProvider (stays direct per D5).
 */
export const FEATURE_TASK_CLASS: Record<string, string> = {
  'suggest-description': TIMEBILL_TASK_CLASSES.INVOICE_NARRATIVE,
  'prebill-narrative': TIMEBILL_TASK_CLASSES.INVOICE_NARRATIVE,
  'reason-code-suggest': TIMEBILL_TASK_CLASSES.INVOICE_NARRATIVE,
  'realization-narrative': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'plain-english-query': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'pricing-suggestion': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'pricing-rationale': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'write-down-patterns': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'anomaly-summary': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'nl-to-filter': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'scope-creep-narrative': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'capacity-narrative': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
  'support-chat': TIMEBILL_TASK_CLASSES.SUPPORT_CHAT,
  'file-naming': TIMEBILL_TASK_CLASSES.FILE_NAMING,
  // GET /status only checks provider availability — it never completes.
  'status-probe': TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
};

/**
 * Fail closed: a feature this map does not know must not silently ride on
 * some default class — sensitivity and budgets derive from the class.
 */
export function taskClassForFeature(feature: string | undefined): string {
  const cls = feature ? FEATURE_TASK_CLASS[feature] : undefined;
  if (!cls) {
    throw new Error(
      `Vibe AI Router mode: feature "${feature ?? '(none)'}" has no task-class mapping — ` +
        'add it to FEATURE_TASK_CLASS in ai/vibe-router.ts.',
    );
  }
  return cls;
}

// ── the provider ─────────────────────────────────────────────────────────

export interface VibeRouterProviderOptions {
  baseUrl: string;
  token: string;
  taskClass: string;
  fetchImpl?: typeof fetch;
}

export function createVibeRouterProvider(opts: VibeRouterProviderOptions): AiProvider {
  if (!opts.baseUrl || !opts.token) {
    throw new Error('vibe-router provider: baseUrl and token are required');
  }
  const client = new VibeAiClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  });
  return {
    id: 'vibe_router',
    async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
      const messages: ChatMessage[] = [];
      if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
      // 0223 — attachments become image parts after the text (vision classes).
      if (req.attachments && req.attachments.length > 0) {
        const parts: (TextPart | ImagePart)[] = [{ type: 'text', text: req.userPrompt }];
        for (const a of req.attachments) {
          parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
        }
        messages.push({ role: 'user', content: parts });
      } else {
        messages.push({ role: 'user', content: req.userPrompt });
      }
      const options = {
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.userId ? { userId: req.userId } : {}),
        ...(req.clientRef ? { clientRef: req.clientRef } : {}),
        ...(req.engagementRef ? { engagementRef: req.engagementRef } : {}),
      };
      try {
        // Structured output: the SDK parses the JSON; we hand it back
        // serialised so AiCompletionResult keeps one shape.
        const result = req.jsonSchema
          ? await client
              .completeJson<unknown>(opts.taskClass, messages, req.jsonSchema, options)
              .then((r) => ({ ...r, content: JSON.stringify(r.data) }))
          : await client.complete(opts.taskClass, messages, options);
        return {
          text: result.content,
          usage: {
            inputTokens: result.usage.promptTokens,
            outputTokens: result.usage.completionTokens,
          },
          providerId: 'vibe_router',
          // Cost accounting lives in the router ledger in router mode; the
          // app-side ai_request_log records 0 so the (inert) local budget
          // never double-counts.
          costEstimateCents: 0,
          model: result.model,
        };
      } catch (err) {
        if (err instanceof VibeAiError) {
          // Preserve the machine-readable code on the rethrow — callers
          // (runAiCompletion's onError) distinguish structured skips like
          // 'no_vision_provider' from transient faults by it.
          throw Object.assign(new Error(`Vibe AI Router: ${err.message} (${err.code})`), {
            code: err.code,
          });
        }
        throw new Error(
          `Vibe AI Router unreachable: ${err instanceof Error ? err.message : String(err)}. ` +
            'Router mode never falls back to a direct provider.',
        );
      }
    },
  };
}

// ── per-feature provider cache ───────────────────────────────────────────

const cache = new Map<string, AiProvider>();

export function routerProviderForFeature(feature: string | undefined): AiProvider {
  const taskClass = taskClassForFeature(feature);
  let p = cache.get(taskClass);
  if (!p) {
    p = createVibeRouterProvider({ ...routerCreds(), taskClass });
    cache.set(taskClass, p);
  }
  return p;
}

/** Test seam. */
export function _clearRouterProviderCacheForTests(): void {
  cache.clear();
}

// Credentials changed (admin save / env refresh) → drop cached providers so
// the next call uses the new URL/token.
onAiRuntimeChange(() => cache.clear());

/** The task-class declarations, exported so the admin "test connection"
 *  can register them against a candidate router before saving. */
export function timeBillingTaskClassDeclarations(): Parameters<
  VibeAiClient['registerTaskClasses']
>[0] {
  return {
    app: 'vibe-time-billing',
    version: appVersion(),
    classes: taskClassDeclarations(),
  };
}

/** Task-class declarations (12.2). New classes start local_only until the
 *  operator widens them in the router console. */
export function taskClassDeclarations(): TaskClassDeclaration[] {
  return [
    // Pack class — declaration matches the reviewed pack entry.
    {
      key: TIMEBILL_TASK_CLASSES.INVOICE_NARRATIVE,
      description: 'Invoice line narrative polish',
      requires: {},
      defaultMaxTokens: 1024,
    },
    {
      key: TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
      description:
        'Practice-metric narratives, NL query translation, and pricing suggestions over firm billing data',
      requires: {},
      defaultMaxTokens: 600,
    },
    {
      key: TIMEBILL_TASK_CLASSES.SUPPORT_CHAT,
      description: 'KB-grounded support chat (staff and client portal)',
      requires: {},
      defaultMaxTokens: 1024,
    },
    {
      key: TIMEBILL_TASK_CLASSES.FILE_NAMING,
      description:
        'Propose a filename for an uploaded client document from its first pages (text or page images) per the firm naming pattern',
      requires: { vision: true, json_schema: true },
      defaultMaxTokens: 300,
    },
  ];
}

// ── boot registration ────────────────────────────────────────────────────

/**
 * Declare this app's task classes on the router (idempotent). Router mode
 * only; non-blocking with backoff — requests made before registration
 * completes fail closed at the router, which is correct.
 */
export function registerTimeBillingTaskClasses(o?: {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}): void {
  if (aiMode() !== 'router') return;
  const log =
    o?.log ?? ((level, msg) => console[level === 'info' ? 'log' : level](`[vibe-router] ${msg}`));
  const client = new VibeAiClient({
    ...routerCreds(),
    ...(o?.fetchImpl ? { fetch: o.fetchImpl } : {}),
  });
  const maxAttempts = o?.maxAttempts ?? 10;
  let attempt = 0;

  const tryRegister = async (): Promise<void> => {
    attempt++;
    try {
      await client.registerTaskClasses(timeBillingTaskClassDeclarations());
      log('info', 'task classes registered');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        log(
          'error',
          `task-class registration failed after ${attempt} attempts: ${message}; AI features fail closed until the router is reachable`,
        );
        return;
      }
      const delayMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      log(
        'warn',
        `task-class registration attempt ${attempt} failed (${message}); retrying in ${Math.round(delayMs / 1000)}s`,
      );
      const timer = setTimeout(() => void tryRegister(), delayMs);
      timer.unref?.();
    }
  };

  void tryRegister();
}
