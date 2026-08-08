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

import { VibeAiClient, VibeAiError, type ChatMessage } from '@kisaes/vibe-ai-client';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from '@vibe/core/ai';

import { appVersion } from '../version';

// ── mode flag ────────────────────────────────────────────────────────────

export type AiMode = 'direct' | 'router';

export function aiMode(): AiMode {
  return process.env['VIBE_AI_MODE'] === 'router' ? 'router' : 'direct';
}

// ── task classes ─────────────────────────────────────────────────────────

export const TIMEBILL_TASK_CLASSES = {
  /** Billing-text drafting over client billing data (default pack, cloud_deidentified) */
  INVOICE_NARRATIVE: 'tb_invoice_narrative',
  /** Practice-metric narratives, NL query translation, pricing (NEW — starts local_only) */
  PRACTICE_ANALYTICS: 'timebill_practice_analytics',
  /** KB-grounded support chat, staff + portal (NEW — starts local_only) */
  SUPPORT_CHAT: 'timebill_support_chat',
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
      messages.push({ role: 'user', content: req.userPrompt });
      try {
        const result = await client.complete(opts.taskClass, messages, {
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.userId ? { userId: req.userId } : {}),
          ...(req.clientRef ? { clientRef: req.clientRef } : {}),
          ...(req.engagementRef ? { engagementRef: req.engagementRef } : {}),
        });
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
          throw new Error(`Vibe AI Router: ${err.message} (${err.code})`);
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
    p = createVibeRouterProvider({
      baseUrl: process.env['VIBE_AI_ROUTER_URL'] ?? '',
      token: process.env['VIBE_AI_TOKEN'] ?? '',
      taskClass,
    });
    cache.set(taskClass, p);
  }
  return p;
}

/** Test seam. */
export function _clearRouterProviderCacheForTests(): void {
  cache.clear();
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
    baseUrl: process.env['VIBE_AI_ROUTER_URL'] ?? '',
    token: process.env['VIBE_AI_TOKEN'] ?? '',
    ...(o?.fetchImpl ? { fetch: o.fetchImpl } : {}),
  });
  const maxAttempts = o?.maxAttempts ?? 10;
  let attempt = 0;

  const tryRegister = async (): Promise<void> => {
    attempt++;
    try {
      await client.registerTaskClasses({
        app: 'vibe-time-billing',
        // A8 — real version even under `node dist/...`, where
        // npm_package_version is unset (see version.ts).
        version: appVersion(),
        classes: [
          // Pack class — declaration matches the reviewed pack entry.
          {
            key: TIMEBILL_TASK_CLASSES.INVOICE_NARRATIVE,
            description: 'Invoice line narrative polish',
            requires: {},
            defaultMaxTokens: 1024,
          },
          // New classes — start local_only until the operator widens them.
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
        ],
      });
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
