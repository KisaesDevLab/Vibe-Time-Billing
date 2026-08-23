// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// AI-feature endpoints (Phase 23). Description suggestion + plain-English
// realization narrative. Provider routing prefers local (Ollama) and
// falls back to cloud per @vibe/core/ai. Budget check (Q14) happens
// before every call; exhausted budgets return 402 with a clear message.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, sql, sum } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { aiRequestLog, clientAiCosts, clients, engagements, firmSettings } from '@vibe/db/schema';
import {
  aiCostPeriod,
  checkBudget,
  type AiCompletionRequest,
  type AiProvider,
} from '@vibe/core/ai';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';
import { aiMode, routerProviderForFeature } from './vibe-router';
import { resolveEgressPolicy, type EgressDecision } from './egress';
import {
  resolveFirmProviders as defaultResolveFirmProviders,
  type ResolvedFirmProviders,
} from './resolve-providers';
import { searchKbArticles, type KbAudience } from '../help/queries';
import { paramSpecPrompt, validateReportParams, extractJsonObject } from './report-params';

export interface AiRoutesDeps extends RbacDeps {
  db: Database | null;
  redis: Redis;
  // Env/boot fallback providers; UI-entered (DB) providers take precedence.
  cloudProvider?: AiProvider | null;
  localProvider?: AiProvider | null;
  /** Resolve per-firm providers from stored credentials (injectable for
   *  tests). Defaults to the real DB-backed resolver. */
  resolveProviders?: (db: Database | null, firmId: string) => Promise<ResolvedFirmProviders>;
  /** Override the wall clock for deterministic tests. */
  now?: () => Date;
}

const DescribeSchema = z.object({
  // A1 — router cost attribution only; resolved server-side to the owning
  // client and never placed in the prompt.
  engagementId: z.string().uuid().optional(),
  engagementName: z.string().max(200).optional(),
  workCodeName: z.string().max(120).optional(),
  hours: z.number().positive().max(24).optional(),
  context: z.string().max(2000).optional(),
});

const NarrativeSchema = z.object({
  realizationPct: z.number(),
  topDrivers: z.array(z.string()).max(20).optional(),
});

const ChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(12),
  maxTokens: z.number().int().min(64).max(2000).optional(),
});

const ReportParamsSchema = z.object({
  reportKind: z.string().min(1).max(60),
  prompt: z.string().min(1).max(1000),
});

// Firm-level AI opt-in (Phase 23 #28). Defaults to true; firms can set
// VIBE_AI_DISABLED=true in env to disable AI features entirely. Future
// enhancement: persist as a firm_settings column with admin toggle.
function firmOptedIn(): boolean {
  return process.env['VIBE_AI_DISABLED'] !== 'true';
}

export function createAiRouter(deps: AiRoutesDeps): Router {
  const router = express.Router();
  const now = deps.now ?? (() => new Date());

  // Status endpoint — UI uses this to hide AI panels on firms that have
  // opted out or that have no provider wired.
  router.get(
    '/status',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      // Pass firmId so status reflects the firm's UI-entered providers +
      // egress policy (the provider a real call would actually use).
      const provider = await pickProvider(deps, undefined, req.staffSession?.firmId);
      res.json({
        enabled: firmOptedIn() && Boolean(provider),
        optedIn: firmOptedIn(),
        providerWired: Boolean(provider),
        providerId: provider?.id ?? null,
      });
    },
  );

  router.post(
    '/suggest-description',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = DescribeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'suggest-description', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }

      const refs = await resolveEngagementRefs(deps, session.firmId, parsed.data.engagementId);
      const started = Date.now();
      let result;
      try {
        result = await provider.complete({
          userId: session.appUserId ?? null,
          clientRef: refs?.clientRef ?? null,
          engagementRef: refs?.engagementRef ?? null,
          systemPrompt:
            'You write concise, professional CPA time entry descriptions. ' +
            'Output exactly one sentence under 20 words. No quotes, no preface.',
          userPrompt: [
            parsed.data.engagementName ? `Engagement: ${parsed.data.engagementName}` : null,
            parsed.data.workCodeName ? `Work code: ${parsed.data.workCodeName}` : null,
            parsed.data.hours != null ? `Hours: ${parsed.data.hours}` : null,
            parsed.data.context ? `Context: ${parsed.data.context}` : null,
            'Write the time entry description:',
          ]
            .filter(Boolean)
            .join('\n'),
          maxTokens: 80,
        });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'description_suggestion',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
        return;
      }

      await logAiRequest(deps, {
        firmId: session.firmId,
        providerId: provider.id,
        feature: 'description_suggestion',
        success: true,
        appUserId: session.appUserId,
        latencyMs: Date.now() - started,
        usage: result.usage,
        costCents: result.costEstimateCents,
      });

      res.json({
        suggestion: result.text.trim(),
        providerId: result.providerId,
        budget:
          budget.kind === 'warn' ? { warn: true, remainingCents: budget.remainingCents } : null,
      });
    },
  );

  router.post(
    '/realization-narrative',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const parsed = NarrativeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'realization-narrative', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }

      const started = Date.now();
      const pct = (parsed.data.realizationPct * 100).toFixed(1);
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          systemPrompt:
            'You are a CPA partner reviewing firm realization. ' +
            'Output a tight 3-sentence narrative. Plain text, no headers, no quotes.',
          userPrompt:
            `Firm realization this period: ${pct}%.\n` +
            (parsed.data.topDrivers?.length
              ? `Top drivers: ${parsed.data.topDrivers.join('; ')}.\n`
              : '') +
            `Write the partner narrative:`,
          maxTokens: 240,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'realization_narrative',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        res.json({
          narrative: result.text.trim(),
          providerId: result.providerId,
          budget:
            budget.kind === 'warn' ? { warn: true, remainingCents: budget.remainingCents } : null,
        });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'realization_narrative',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  router.post(
    '/plain-english-query',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const question =
        typeof req.body?.question === 'string' ? req.body.question.slice(0, 800) : '';
      if (!question) {
        res.status(400).json({ error: 'question_required' });
        return;
      }
      const provider = await pickProvider(deps, 'plain-english-query', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          systemPrompt:
            'You translate plain-English questions about a CPA practice into a brief plan ' +
            'describing which reports or queries to run. Output 2-4 short bullet points. ' +
            'No code, no SQL.',
          userPrompt: question,
          maxTokens: 240,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'plain_english_query',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        // Phase 23 #18 — surface citations so the UI can render
        // clickable links to the underlying reports referenced by the
        // model's plan. We mine the answer text for known report names.
        const citations = inferCitations(result.text);
        res.json({
          answer: result.text.trim(),
          providerId: result.providerId,
          citations,
        });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'plain_english_query',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  // -----------------------------------------------------------------
  // Pricing suggestion (Phase 23 #11). Given engagement type + service
  // line context, returns a short pricing recommendation.
  // -----------------------------------------------------------------
  router.post(
    '/pricing-suggestion',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const Schema = z.object({
        engagementTypeName: z.string().max(120),
        serviceLineName: z.string().max(120).optional(),
        clientName: z.string().max(120).optional(),
        complexity: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
        // A1 — no current SPA caller sends this (the admin card is free-text);
        // accepted so future entity-scoped callers can attribute cost.
        engagementId: z.string().uuid().optional(),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'pricing-suggestion', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const refs = await resolveEngagementRefs(deps, session.firmId, parsed.data.engagementId);
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          clientRef: refs?.clientRef ?? null,
          engagementRef: refs?.engagementRef ?? null,
          systemPrompt:
            'You are a CPA practice consultant. Given an engagement type, suggest a ' +
            'fixed-fee range and a typical effort range. Output 3 short lines: ' +
            '"Fee range:", "Effort:", "Notes:". Plain text, no preface.',
          userPrompt: [
            `Engagement type: ${parsed.data.engagementTypeName}`,
            parsed.data.serviceLineName ? `Service line: ${parsed.data.serviceLineName}` : null,
            parsed.data.clientName ? `Client: ${parsed.data.clientName}` : null,
            parsed.data.complexity ? `Complexity: ${parsed.data.complexity}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          maxTokens: 200,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'pricing_suggestion',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        res.json({ suggestion: result.text.trim(), providerId: result.providerId });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'pricing_suggestion',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  // -----------------------------------------------------------------
  // Write-down pattern analysis (Phase 23 #12).
  // -----------------------------------------------------------------
  router.post(
    '/write-down-patterns',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const Schema = z.object({
        samples: z
          .array(
            z.object({
              reason: z.string().max(120).optional(),
              amountCents: z.number().int(),
              method: z.string().max(40),
              engagementType: z.string().max(120).optional(),
            }),
          )
          .min(1)
          .max(50),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'write-down-patterns', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          systemPrompt:
            'You analyze CPA write-down patterns. Given a sample of recent adjustments, ' +
            'identify 2-4 short patterns (theme + frequency). No headers, no preface.',
          userPrompt: JSON.stringify(parsed.data.samples).slice(0, 4000),
          maxTokens: 300,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'write_down_patterns',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        res.json({ patterns: result.text.trim(), providerId: result.providerId });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'write_down_patterns',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  // -----------------------------------------------------------------
  // Reason-code suggestion (Phase 23 #19). Picks one of the supplied
  // catalog entries that best fits the supplied context.
  // -----------------------------------------------------------------
  router.post(
    '/reason-code-suggest',
    requirePermission(deps, 'adjustment:create'),
    async (req: Request, res: Response) => {
      const Schema = z.object({
        context: z.string().max(1000),
        amountCents: z.number().int().optional(),
        availableReasons: z.array(z.string().max(80)).min(1).max(60),
        // A1 — no current SPA caller; accepted for future attribution.
        engagementId: z.string().uuid().optional(),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'reason-code-suggest', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const refs = await resolveEngagementRefs(deps, session.firmId, parsed.data.engagementId);
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          clientRef: refs?.clientRef ?? null,
          engagementRef: refs?.engagementRef ?? null,
          systemPrompt:
            'You pick the best-matching reason code for a CPA write-down/up. Output exactly ' +
            'one of the supplied options, verbatim. No explanation, no quotes.',
          userPrompt:
            `Context: ${parsed.data.context}\n` +
            (parsed.data.amountCents != null ? `Amount cents: ${parsed.data.amountCents}\n` : '') +
            `Options: ${parsed.data.availableReasons.join(' | ')}`,
          maxTokens: 30,
        });
        const picked = result.text.trim().replace(/^"|"$/g, '');
        const match = parsed.data.availableReasons.find((r) => r === picked) ?? null;
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'reason_code_suggest',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        res.json({ pick: match, raw: picked, providerId: result.providerId });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'reason_code_suggest',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  // -----------------------------------------------------------------
  // Pre-bill narrative (Phase 23 #25). Given a batch summary (counts +
  // amounts), generates a 2-3 sentence executive summary for the partner
  // review. No PII flows to the LLM — caller passes aggregated counts.
  // -----------------------------------------------------------------
  router.post(
    '/prebill-narrative',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      const Schema = z.object({
        // A1 — attribution only; resolved server-side, never in the prompt.
        engagementId: z.string().uuid().optional(),
        clientName: z.string().max(120).optional(),
        engagementName: z.string().max(200).optional(),
        entryCount: z.number().int().nonnegative(),
        totalHours: z.number().nonnegative(),
        totalAmountCents: z.number().int().nonnegative(),
        oldestEntryDate: z.string().optional(),
        adjustmentCount: z.number().int().nonnegative().optional(),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'prebill-narrative', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const refs = await resolveEngagementRefs(deps, session.firmId, parsed.data.engagementId);
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          clientRef: refs?.clientRef ?? null,
          engagementRef: refs?.engagementRef ?? null,
          systemPrompt:
            'You write 2-3 sentence pre-bill summaries for CPA partners. Output plain text, no headers.',
          userPrompt: [
            parsed.data.clientName ? `Client: ${parsed.data.clientName}` : null,
            parsed.data.engagementName ? `Engagement: ${parsed.data.engagementName}` : null,
            `Entries: ${parsed.data.entryCount}`,
            `Hours: ${parsed.data.totalHours.toFixed(2)}`,
            `Standard amount: $${(parsed.data.totalAmountCents / 100).toFixed(2)}`,
            parsed.data.oldestEntryDate ? `Oldest entry: ${parsed.data.oldestEntryDate}` : null,
            parsed.data.adjustmentCount != null
              ? `Adjustments applied: ${parsed.data.adjustmentCount}`
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
          maxTokens: 200,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'prebill_narrative',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        res.json({ narrative: result.text.trim(), providerId: result.providerId });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'prebill_narrative',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  // -----------------------------------------------------------------
  // AI-augmented anomaly detection (Phase 23 #10). Combines the rule-
  // based scope_creep + wip_age + audit_anomaly alerts from audit_log
  // with an LLM summary that explains the patterns in partner-readable
  // language. The LLM never sees PII — only aggregated counts.
  // -----------------------------------------------------------------
  router.post(
    '/anomaly-summary',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'anomaly-summary', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const body = req.body as { alerts?: unknown };
      if (!Array.isArray(body.alerts) || body.alerts.length === 0) {
        res.status(400).json({ error: 'alerts_required' });
        return;
      }
      // Strip ids; only types + counts go to the LLM.
      const summary = body.alerts.reduce<Record<string, number>>((acc, a) => {
        if (typeof a === 'object' && a !== null) {
          const t = String((a as { entityType?: unknown }).entityType ?? 'unknown');
          acc[t] = (acc[t] ?? 0) + 1;
        }
        return acc;
      }, {});
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          systemPrompt:
            'You explain CPA practice anomalies to a partner. Output 2-3 short bullet ' +
            'points listing the most concerning patterns and a one-line suggested action ' +
            'for each. No PII.',
          userPrompt:
            'Alert counts by type:\n' +
            Object.entries(summary)
              .map(([k, v]) => `- ${k}: ${v}`)
              .join('\n'),
          maxTokens: 280,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'anomaly_summary',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        res.json({ summary, narrative: result.text.trim(), providerId: result.providerId });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'anomaly_summary',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  // -----------------------------------------------------------------
  // Natural-language → filter object (Phase 23 #17). Translates a
  // plain-English question into a structured filter that the staff UI
  // can apply to existing report endpoints. Returns JSON with a `target`
  // (which report) and `params` (the filters).
  // -----------------------------------------------------------------
  router.post(
    '/nl-to-filter',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const body = req.body as { question?: unknown };
      const question = typeof body.question === 'string' ? body.question.slice(0, 600) : '';
      if (!question) {
        res.status(400).json({ error: 'question_required' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'nl-to-filter', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          systemPrompt:
            'You translate plain-English questions about a CPA practice into a JSON object describing ' +
            'which report endpoint to query and which filter parameters. Output ONLY valid JSON with ' +
            'fields: target (one of: realization, profitability, ar_aging, mrr, dso, utilization, ' +
            'effective_rate, capacity_forecast, scope_creep), params (object), confidence (0-1).',
          userPrompt: question,
          maxTokens: 200,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'nl_to_filter',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        // Try to extract just the JSON object from the response.
        const text = result.text.trim();
        let parsed: unknown = null;
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            parsed = JSON.parse(match[0]);
          } catch {
            // ignore
          }
        }
        res.json({
          filter: parsed,
          rawText: text,
          providerId: result.providerId,
        });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'nl_to_filter',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  // Phase 23 #13 — scope-creep narrative. Wraps the rule-based
  // /reports/scope-creep output in a 2-sentence partner-facing summary
  // explaining the at-risk engagements + one recommendation.
  router.post(
    '/scope-creep-narrative',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'scope-creep-narrative', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const body = req.body as {
        flagged?: Array<{ engagementName?: string; oosPct?: number; oosHours?: number }>;
      };
      const flagged = Array.isArray(body.flagged) ? body.flagged.slice(0, 20) : [];
      if (flagged.length === 0) {
        res.json({ narrative: 'No engagements currently showing scope creep.' });
        return;
      }
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          systemPrompt:
            'You are a CPA practice consultant. Given a list of mixed-mode engagements where ' +
            'out-of-scope hours have spiked, write a 2-sentence partner-facing summary plus one ' +
            'concrete recommendation. Plain text. No engagement names invented; only use the list.',
          userPrompt: flagged
            .map(
              (f, i) =>
                `${i + 1}. ${f.engagementName ?? 'engagement'} — OOS ${f.oosPct?.toFixed?.(0) ?? '?'}% (${f.oosHours?.toFixed?.(1) ?? '?'}h)`,
            )
            .join('\n'),
          maxTokens: 220,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'scope_creep_narrative',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        res.json({ narrative: result.text, providerId: result.providerId });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'scope_creep_narrative',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  // Phase 23 #15 — capacity narrative. Wraps the rolling-average forecast
  // in a 2-sentence summary highlighting overcapacity and undercapacity
  // timekeepers + one staffing recommendation.
  router.post(
    '/capacity-narrative',
    requirePermission(deps, 'report:utilization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'capacity-narrative', session.firmId);
      if (!provider) {
        res.status(503).json({ error: 'no_ai_provider' });
        return;
      }
      const budget = await loadBudget(deps, session.firmId, now());
      if (budget.kind === 'exhausted') {
        res.status(402).json({ error: 'ai_budget_exhausted', resetsOn: budget.resetsOn });
        return;
      }
      const body = req.body as {
        forecasts?: Array<{
          fullName?: string;
          weeklyAvgHours?: number;
          projectedNext4Weeks?: number;
          varianceVsTarget?: number;
        }>;
      };
      const items = Array.isArray(body.forecasts) ? body.forecasts.slice(0, 30) : [];
      if (items.length === 0) {
        res.json({ narrative: 'No capacity data available yet.' });
        return;
      }
      const started = Date.now();
      try {
        const result = await provider.complete({
          userId: session.appUserId ?? null,
          systemPrompt:
            'You are a CPA practice consultant. Given a list of timekeepers with their 4-week ' +
            'projected hours and variance vs target, write a 2-sentence partner-facing summary ' +
            'flagging overcapacity (variance ≪ 0) and undercapacity (variance ≫ 0) names, plus ' +
            'one concrete staffing recommendation. Plain text.',
          userPrompt: items
            .map(
              (r, i) =>
                `${i + 1}. ${r.fullName ?? 'staff'} — avg ${r.weeklyAvgHours?.toFixed?.(1) ?? '?'}h/wk, projected ${r.projectedNext4Weeks?.toFixed?.(1) ?? '?'}h in 4w, variance ${r.varianceVsTarget?.toFixed?.(0) ?? '?'}h`,
            )
            .join('\n'),
          maxTokens: 220,
        });
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'capacity_narrative',
          success: true,
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
          usage: result.usage,
          costCents: result.costEstimateCents,
        });
        res.json({ narrative: result.text, providerId: result.providerId });
      } catch (err) {
        await logAiRequest(deps, {
          firmId: session.firmId,
          providerId: provider.id,
          feature: 'capacity_narrative',
          success: false,
          errorMessage: err instanceof Error ? err.message : 'unknown',
          appUserId: session.appUserId,
          latencyMs: Date.now() - started,
        });
        res.status(502).json({ error: 'ai_provider_failed' });
      }
    },
  );

  router.get(
    '/request-log',
    requirePermission(deps, 'admin:ai:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '30'), 10) || 30, 1),
        180,
      );
      const feature = typeof req.query['feature'] === 'string' ? req.query['feature'] : null;
      const userId = uuidQueryParam(req.query['appUserId']);
      if (userId === 'invalid') {
        res.status(400).json({ error: 'invalid_app_user_id' });
        return;
      }
      const since = new Date(Date.now() - days * 86_400_000);
      const conds = [eq(aiRequestLog.firmId, session.firmId), gte(aiRequestLog.occurredAt, since)];
      if (feature) conds.push(eq(aiRequestLog.feature, feature));
      if (userId) conds.push(eq(aiRequestLog.appUserId, userId));
      const items = await deps.db
        .select()
        .from(aiRequestLog)
        .where(and(...conds))
        .orderBy(desc(aiRequestLog.occurredAt))
        .limit(500);
      res.json({ items });
    },
  );

  router.get(
    '/metrics',
    requirePermission(deps, 'admin:ai:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: null });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '30'), 10) || 30, 1),
        365,
      );
      const since = new Date(Date.now() - days * 86_400_000);
      const [totals] = await deps.db
        .select({
          totalRequests: sql<number>`COUNT(*)`,
          failedRequests: sql<number>`COUNT(*) FILTER (WHERE ${aiRequestLog.success} = false)`,
          totalCostCents: sql<number>`COALESCE(SUM(${aiRequestLog.costCents}), 0)`,
          totalInputTokens: sql<number>`COALESCE(SUM(${aiRequestLog.requestTokens}), 0)`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${aiRequestLog.responseTokens}), 0)`,
          avgLatencyMs: sql<number>`COALESCE(AVG(${aiRequestLog.latencyMs}), 0)`,
        })
        .from(aiRequestLog)
        .where(and(eq(aiRequestLog.firmId, session.firmId), gte(aiRequestLog.occurredAt, since)));
      const perFeature = await deps.db
        .select({
          feature: aiRequestLog.feature,
          requests: sql<number>`COUNT(*)`,
          costCents: sql<number>`COALESCE(SUM(${aiRequestLog.costCents}), 0)`,
        })
        .from(aiRequestLog)
        .where(and(eq(aiRequestLog.firmId, session.firmId), gte(aiRequestLog.occurredAt, since)))
        .groupBy(aiRequestLog.feature);
      const [settings] = await deps.db
        .select({
          monthly: firmSettings.aiMonthlyBudgetCents,
          warn: firmSettings.aiWarnThresholdPct,
        })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, session.firmId))
        .limit(1);
      const monthly = settings ? Number(settings.monthly) : null;
      const spent = Number(totals?.totalCostCents ?? 0);
      const usagePct = monthly && monthly > 0 ? (spent / monthly) * 100 : null;
      res.json({
        windowDays: days,
        totals: {
          requests: Number(totals?.totalRequests ?? 0),
          failed: Number(totals?.failedRequests ?? 0),
          costCents: spent,
          inputTokens: Number(totals?.totalInputTokens ?? 0),
          outputTokens: Number(totals?.totalOutputTokens ?? 0),
          avgLatencyMs: Math.round(Number(totals?.avgLatencyMs ?? 0)),
        },
        perFeature: perFeature.map((p) => ({
          feature: p.feature,
          requests: Number(p.requests),
          costCents: Number(p.costCents),
        })),
        budget: {
          monthlyBudgetCents: monthly,
          warnThresholdPct: settings ? Number(settings.warn) : null,
          usagePct,
        },
      });
    },
  );

  // -------------------------------------------------------------------
  // GET /client-costs — A1 (MIG-8 cost recovery). Per-client AI spend for
  // a yyyymm period, read from client_ai_cost (synced daily from the
  // router billing feed by the worker's ai-cost-sync job). Totals are
  // computed server-side. Includes aiMode so the page can show/hide the
  // card without a second (differently-permissioned) fetch.
  // -------------------------------------------------------------------
  router.get(
    '/client-costs',
    requirePermission(deps, 'admin:ai:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const mode = aiMode();
      if (!deps.db) {
        res.json({ period: null, aiMode: mode, items: [], totals: null });
        return;
      }
      const raw = typeof req.query['period'] === 'string' ? req.query['period'] : '';
      const period = /^\d{6}$/.test(raw) ? raw : aiCostPeriod(now());

      const items = await deps.db
        .select({
          clientId: clientAiCosts.clientId,
          clientName: clients.name,
          engagementId: clientAiCosts.engagementId,
          engagementName: engagements.name,
          app: clientAiCosts.app,
          taskClass: clientAiCosts.taskClass,
          requests: clientAiCosts.requests,
          promptTokens: clientAiCosts.promptTokens,
          completionTokens: clientAiCosts.completionTokens,
          costCents: clientAiCosts.costCents,
          syncedAt: clientAiCosts.syncedAt,
        })
        .from(clientAiCosts)
        .innerJoin(clients, eq(clients.id, clientAiCosts.clientId))
        .leftJoin(engagements, eq(engagements.id, clientAiCosts.engagementId))
        .where(and(eq(clientAiCosts.firmId, session.firmId), eq(clientAiCosts.period, period)))
        .orderBy(desc(clientAiCosts.costCents), clients.name);

      const totals = items.reduce(
        (t, r) => ({
          requests: t.requests + r.requests,
          promptTokens: t.promptTokens + r.promptTokens,
          completionTokens: t.completionTokens + r.completionTokens,
          costCents: t.costCents + r.costCents,
        }),
        { requests: 0, promptTokens: 0, completionTokens: 0, costCents: 0 },
      );

      res.json({ period, aiMode: mode, items, totals });
    },
  );

  // ---------------------------------------------------------------------
  // POST /chat — KB-grounded support assistant. Retrieves the most
  // relevant published knowledge-base articles for the question and asks
  // the model to answer from them. Open to any authenticated staff
  // member (the /api/staff/ai mount already enforces auth+CSRF), since
  // help should be universal. Respects provider wiring + the monthly
  // budget like every other AI feature.
  // ---------------------------------------------------------------------
  router.post('/chat', async (req: Request, res: Response) => {
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession!;
    // Staff see all articles (no audience filter).
    const out = await runKbChat(deps, {
      firmId: session.firmId,
      messages: parsed.data.messages,
      maxTokens: parsed.data.maxTokens,
      actorAppUserId: session.appUserId,
      feature: 'support_chat',
    });
    sendKbChat(res, out);
  });

  // ---------------------------------------------------------------------
  // POST /report-params — turn a plain-English description into a validated
  // params object for a saved report of the given kind. Powers the
  // "Suggest params with AI" button in the saved-reports admin.
  // ---------------------------------------------------------------------
  router.post('/report-params', async (req: Request, res: Response) => {
    const parsed = ReportParamsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession!;
    const out = await runReportParams(deps, {
      firmId: session.firmId,
      reportKind: parsed.data.reportKind,
      prompt: parsed.data.prompt,
      actorAppUserId: session.appUserId,
    });
    if (!out.ok) {
      res.status(out.status).json({
        error: out.error,
        ...(out.resetsOn ? { resetsOn: out.resetsOn } : {}),
      });
      return;
    }
    res.json({ params: out.params, providerId: out.providerId });
  });

  return router;
}

// Phase 23 #7 — per-feature provider override. Default is local-first
// (Q15). Each feature can pin to 'local' | 'cloud' via env var of the
// form `VIBE_AI_FEATURE_<NAME>` (uppercased, dashes → underscores).
// Examples:
//   VIBE_AI_FEATURE_REALIZATION_NARRATIVE=cloud
//   VIBE_AI_FEATURE_SUGGEST_DESCRIPTION=local
// Unset values inherit the global default.
// Phase 23 #18 — map of report keywords to API endpoints. The UI uses
// the returned `path` to render clickable links beside the answer.
const REPORT_INDEX: ReadonlyArray<{ keywords: string[]; label: string; path: string }> = [
  {
    keywords: ['realization', 'wip'],
    label: 'Realization report',
    path: '/api/reports/realization',
  },
  {
    keywords: ['aging', 'a/r', 'accounts receivable'],
    label: 'A/R aging',
    path: '/api/reports/ar-aging',
  },
  {
    keywords: ['utilization', 'productivity'],
    label: 'Utilization report',
    path: '/api/reports/utilization',
  },
  {
    keywords: ['write-down', 'write down', 'write-up', 'write up', 'adjustment'],
    label: 'Adjustment history',
    path: '/api/reports/adjustments',
  },
  { keywords: ['budget', 'over budget'], label: 'Budget vs actual', path: '/api/reports/budget' },
  { keywords: ['invoice', 'billing'], label: 'Invoice list', path: '/api/invoices' },
  {
    keywords: ['time entry', 'time entries', 'hours'],
    label: 'Time entries',
    path: '/api/time-entries',
  },
];

function inferCitations(answer: string): Array<{ label: string; path: string }> {
  const lower = answer.toLowerCase();
  const hits: Array<{ label: string; path: string }> = [];
  for (const entry of REPORT_INDEX) {
    if (entry.keywords.some((k) => lower.includes(k))) {
      hits.push({ label: entry.label, path: entry.path });
    }
  }
  return hits;
}

function featureOverride(feature: string | undefined): 'local' | 'cloud' | null {
  if (!feature) return null;
  const key = `VIBE_AI_FEATURE_${feature.toUpperCase().replace(/-/g, '_')}`;
  const v = process.env[key];
  if (v === 'local' || v === 'cloud') return v;
  return null;
}

async function pickProvider(
  deps: AiRoutesDeps,
  feature?: string,
  firmId?: string,
): Promise<AiProvider | null> {
  // MIG-8: router mode short-circuits everything below — firm credentials,
  // the egress gate, and local-vs-cloud preference are all the router
  // console's job now (task classes carry the data boundary). This never
  // falls through to a direct provider: a router outage must surface as a
  // failed call, not silently ship prompts around the scrubber and ledger.
  if (aiMode() === 'router') {
    return routerProviderForFeature(feature ?? 'status-probe');
  }
  const override = featureOverride(feature);

  // 0100 — prefer the firm's UI-entered (DB) providers; fall back to the
  // env/boot providers when none are configured.
  let cloud = deps.cloudProvider ?? null;
  let local = deps.localProvider ?? null;
  if (firmId) {
    const resolve = deps.resolveProviders ?? defaultResolveFirmProviders;
    const firmProviders = await resolve(deps.db, firmId);
    cloud = firmProviders.cloud ?? cloud;
    local = firmProviders.local ?? local;
  }

  // P5.1 — egress gate. Resolves the per-firm policy. If the firm is
  // local-only (default), cloud overrides are silently downgraded to
  // local. If shield is unreachable, cloud is denied. firmId is
  // optional only for the /status probe; every real call passes it.
  let decision: EgressDecision = { kind: 'local-only', reason: 'firm-policy' };
  if (firmId) {
    decision = await resolveEgressPolicy({ db: deps.db, redis: deps.redis, firmId });
  }
  // 0100 — cloud is permitted under either a reachable shield or the
  // explicit direct egress mode.
  const cloudAllowed = decision.kind === 'shield-ok' || decision.kind === 'direct-ok';
  if (!cloudAllowed) {
    if (override === 'cloud') {
      logger.warn({ firmId, decision }, 'ai egress: cloud override blocked by policy');
    }
    return local;
  }
  if (override === 'cloud') return cloud ?? local;
  if (override === 'local') return local ?? cloud;
  // Q15 — local preferred even when cloud is permitted.
  return local ?? cloud;
}

/**
 * Exported for MCP / Connect tools that want to surface the egress
 * decision (e.g. to deregister cloud-only tools when shield is down).
 */
export async function getEgressDecision(
  deps: { db: Database | null; redis: Redis },
  firmId: string,
): Promise<EgressDecision> {
  return resolveEgressPolicy({ db: deps.db, redis: deps.redis, firmId });
}

async function loadBudget(
  deps: AiRoutesDeps,
  firmId: string,
  now: Date,
): Promise<ReturnType<typeof checkBudget>> {
  if (!deps.db) return { kind: 'ok' };
  const [settings] = await deps.db
    .select({
      monthly: firmSettings.aiMonthlyBudgetCents,
      warn: firmSettings.aiWarnThresholdPct,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (!settings) return { kind: 'ok' };
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [spent] = await deps.db
    .select({ total: sum(aiRequestLog.costCents) })
    .from(aiRequestLog)
    .where(and(eq(aiRequestLog.firmId, firmId), gte(aiRequestLog.occurredAt, monthStart)));
  return checkBudget(
    {
      monthlyBudgetCents: Number(settings.monthly),
      warnThresholdPct: settings.warn,
      spentCents: Number(spent?.total ?? 0),
    },
    now,
  );
}

interface LogArgs {
  firmId: string;
  providerId: string;
  feature: string;
  success: boolean;
  errorMessage?: string;
  // Null for portal-realm callers (no app_user); the column is nullable.
  appUserId: string | null;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  costCents?: number;
}

async function logAiRequest(deps: AiRoutesDeps, args: LogArgs): Promise<void> {
  if (!deps.db) return;
  const providerEnum = (
    {
      anthropic: 'ANTHROPIC',
      ollama: 'LOCAL_OLLAMA',
      openai_compatible: 'OPENAI_COMPATIBLE',
      vibe_router: 'VIBE_ROUTER',
    } as const
  )[args.providerId as 'anthropic' | 'ollama' | 'openai_compatible' | 'vibe_router'];
  await deps.db
    .insert(aiRequestLog)
    .values({
      firmId: args.firmId,
      provider: providerEnum ?? 'OPENAI_COMPATIBLE',
      model: args.providerId,
      feature: args.feature,
      requestTokens: args.usage?.inputTokens ?? null,
      responseTokens: args.usage?.outputTokens ?? null,
      costCents: args.costCents ?? null,
      latencyMs: args.latencyMs,
      success: args.success,
      errorMessage: args.errorMessage ?? null,
      appUserId: args.appUserId,
    })
    .catch((err: unknown) => logger.error({ err }, 'ai log failed'));
}

/**
 * A1 — resolve an engagement id to router attribution refs. Callers never
 * send a bare clientId (a client-supplied one can't be trusted for cost
 * attribution); they send an engagementId and the owning client is derived
 * here under firm scoping. Attribution is telemetry, not authz: an
 * unresolvable or foreign id silently drops attribution rather than
 * failing the request. IDs never enter prompt text.
 */
async function resolveEngagementRefs(
  deps: AiRoutesDeps,
  firmId: string,
  engagementId: string | undefined,
): Promise<{ clientRef: string; engagementRef: string } | null> {
  if (!engagementId || !deps.db) return null;
  try {
    const [row] = await deps.db
      .select({ clientId: clients.id })
      .from(engagements)
      .innerJoin(clients, eq(clients.id, engagements.clientId))
      .where(and(eq(engagements.id, engagementId), eq(clients.firmId, firmId)))
      .limit(1);
    return row ? { clientRef: row.clientId, engagementRef: engagementId } : null;
  } catch (err) {
    logger.warn({ err, engagementId }, 'ai attribution resolve failed');
    return null;
  }
}

/**
 * Reusable best-effort completion for non-AI-first features (e.g. the pricing
 * rationale). Applies the same egress gate, budget cap, and request logging as
 * the AI endpoints. Returns null — never throws — when no provider is
 * available, the budget is exhausted, or the call fails, so callers degrade to
 * a templated fallback.
 */
export async function runAiCompletion(
  deps: AiRoutesDeps,
  args: {
    firmId: string;
    appUserId?: string;
    feature: string;
    systemPrompt: string;
    userPrompt: string;
    maxTokens?: number;
    /** A1 — router cost attribution (ledger dimensions, never in prompts). */
    clientId?: string | null;
    engagementId?: string | null;
    /** 0223 — router-only: page images + structured output. */
    attachments?: AiCompletionRequest['attachments'];
    jsonSchema?: AiCompletionRequest['jsonSchema'];
    /** Model that served the request is reported here when the caller cares. */
    onResult?: (r: { model?: string; providerId: string }) => void;
  },
): Promise<string | null> {
  const provider = await pickProvider(deps, args.feature, args.firmId);
  if (!provider) return null;
  const budget = await loadBudget(deps, args.firmId, deps.now?.() ?? new Date());
  if (budget.kind === 'exhausted') return null;
  const started = Date.now();
  try {
    const result = await provider.complete({
      userId: args.appUserId ?? null,
      clientRef: args.clientId ?? null,
      engagementRef: args.engagementId ?? null,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      maxTokens: args.maxTokens ?? 220,
      ...(args.attachments ? { attachments: args.attachments } : {}),
      ...(args.jsonSchema ? { jsonSchema: args.jsonSchema } : {}),
    });
    args.onResult?.({ model: result.model, providerId: result.providerId });
    await logAiRequest(deps, {
      firmId: args.firmId,
      providerId: provider.id,
      feature: args.feature,
      success: true,
      appUserId: args.appUserId ?? null,
      latencyMs: Date.now() - started,
      usage: result.usage,
      costCents: result.costEstimateCents,
    });
    return result.text;
  } catch (err) {
    await logAiRequest(deps, {
      firmId: args.firmId,
      providerId: provider.id,
      feature: args.feature,
      success: false,
      errorMessage: err instanceof Error ? err.message : 'unknown',
      appUserId: args.appUserId ?? null,
      latencyMs: Date.now() - started,
    });
    return null;
  }
}

// =====================================================================
// KB-grounded support chat — shared by the staff (/api/staff/ai/chat)
// and portal (/api/portal/ai/chat) routers. Framework-agnostic: returns
// a discriminated result the caller maps to HTTP. `audiences` restricts
// KB retrieval to a realm (portal passes ['client','both']); omitting it
// searches all articles (staff). `actorAppUserId` is null for portal.
// =====================================================================
export interface KbChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface KbChatArgs {
  firmId: string;
  messages: KbChatMessage[];
  maxTokens?: number;
  audiences?: KbAudience[];
  actorAppUserId?: string | null;
  feature?: string;
  /** A1 — router cost attribution: the portal caller's active client. */
  clientId?: string | null;
}
export type KbChatResult =
  | {
      ok: true;
      message: string;
      providerId: string;
      sources: { slug: string; title: string }[];
      budget: { warn: true; remainingCents: number } | null;
    }
  | { ok: false; status: number; error: string; resetsOn?: string };

export async function runKbChat(deps: AiRoutesDeps, args: KbChatArgs): Promise<KbChatResult> {
  const nowFn = deps.now ?? (() => new Date());
  const feature = args.feature ?? 'support_chat';
  const provider = await pickProvider(deps, 'support-chat', args.firmId);
  if (!provider) return { ok: false, status: 503, error: 'no_ai_provider' };

  const budget = await loadBudget(deps, args.firmId, nowFn());
  if (budget.kind === 'exhausted') {
    return { ok: false, status: 402, error: 'ai_budget_exhausted', resetsOn: budget.resetsOn };
  }

  const lastUser = [...args.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  // Retrieve KB context to ground the answer (realm-scoped).
  const hits = await searchKbArticles(deps.db, args.firmId, lastUser, 4, args.audiences);
  const context = hits
    .map(
      (h, i) =>
        `[Article ${i + 1}] ${h.title}\n${h.summary ? h.summary + '\n' : ''}${h.bodyMarkdown.slice(0, 1200)}`,
    )
    .join('\n\n---\n\n');

  const systemPrompt =
    'You are the in-app support assistant for Vibe Practice Management, a CPA ' +
    'practice-management appliance. Answer the user using ONLY the support ' +
    'articles provided below. Be concise and practical, and reference the ' +
    'relevant screen or menu when helpful. If the answer is not covered by the ' +
    'articles, say so plainly and suggest browsing the Knowledge Base or asking ' +
    'a firm administrator — do not invent features.\n\n' +
    (context ? `SUPPORT ARTICLES:\n${context}` : 'SUPPORT ARTICLES: (none matched this question)');

  const history = args.messages
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const started = Date.now();
  try {
    const result = await provider.complete({
      userId: args.actorAppUserId ?? null,
      clientRef: args.clientId ?? null,
      systemPrompt,
      userPrompt: `${history}\n\nAnswer the user's latest question.`,
      maxTokens: args.maxTokens ?? 600,
      temperature: 0.2,
    });
    await logAiRequest(deps, {
      firmId: args.firmId,
      providerId: provider.id,
      feature,
      success: true,
      appUserId: args.actorAppUserId ?? null,
      latencyMs: Date.now() - started,
      usage: result.usage,
      costCents: result.costEstimateCents,
    });
    return {
      ok: true,
      message: result.text.trim(),
      providerId: result.providerId,
      sources: hits.map((h) => ({ slug: h.slug, title: h.title })),
      budget: budget.kind === 'warn' ? { warn: true, remainingCents: budget.remainingCents } : null,
    };
  } catch (err) {
    await logAiRequest(deps, {
      firmId: args.firmId,
      providerId: provider.id,
      feature,
      success: false,
      errorMessage: err instanceof Error ? err.message : 'unknown',
      appUserId: args.actorAppUserId ?? null,
      latencyMs: Date.now() - started,
    });
    return { ok: false, status: 502, error: 'ai_provider_failed' };
  }
}

/** Map a KbChatResult onto an Express response. */
export function sendKbChat(res: Response, out: KbChatResult): void {
  if (!out.ok) {
    res.status(out.status).json({
      error: out.error,
      ...(out.resetsOn ? { resetsOn: out.resetsOn } : {}),
    });
    return;
  }
  res.json({
    message: out.message,
    providerId: out.providerId,
    sources: out.sources,
    budget: out.budget,
  });
}

export type ReportParamsResult =
  | { ok: true; params: Record<string, unknown>; providerId: string }
  | { ok: false; status: number; error: string; resetsOn?: string };

/**
 * Turn a natural-language request into a validated params object for a saved
 * report of the given kind. Output is constrained by the kind's server-side
 * param spec and validated before return — the model never produces free-form
 * config that the report endpoints wouldn't accept.
 */
export async function runReportParams(
  deps: AiRoutesDeps,
  args: { firmId: string; reportKind: string; prompt: string; actorAppUserId?: string | null },
): Promise<ReportParamsResult> {
  const specPrompt = paramSpecPrompt(args.reportKind);
  if (!specPrompt) return { ok: false, status: 400, error: 'unknown_report_kind' };

  const nowFn = deps.now ?? (() => new Date());
  const provider = await pickProvider(deps, 'support-chat', args.firmId);
  if (!provider) return { ok: false, status: 503, error: 'no_ai_provider' };
  const budget = await loadBudget(deps, args.firmId, nowFn());
  if (budget.kind === 'exhausted') {
    return { ok: false, status: 402, error: 'ai_budget_exhausted', resetsOn: budget.resetsOn };
  }

  const systemPrompt =
    'You convert a natural-language request into a JSON parameters object for a ' +
    'saved report. Output ONLY a single minified JSON object — no prose, no code ' +
    'fences. Use only the allowed parameter names; omit any not clearly implied ' +
    'by the request. Dates must be YYYY-MM-DD.\n\n' +
    specPrompt;

  const started = Date.now();
  try {
    const result = await provider.complete({
      systemPrompt,
      userPrompt: `Request: ${args.prompt}\n\nJSON parameters:`,
      maxTokens: 200,
      temperature: 0,
    });
    await logAiRequest(deps, {
      firmId: args.firmId,
      providerId: provider.id,
      feature: 'report_params',
      success: true,
      appUserId: args.actorAppUserId ?? null,
      latencyMs: Date.now() - started,
      usage: result.usage,
      costCents: result.costEstimateCents,
    });
    const json = extractJsonObject(result.text);
    if (json === null) return { ok: false, status: 422, error: 'no_json_returned' };
    const v = validateReportParams(args.reportKind, json);
    if (!v.ok) return { ok: false, status: 422, error: v.error };
    return { ok: true, params: v.params, providerId: result.providerId };
  } catch (err) {
    await logAiRequest(deps, {
      firmId: args.firmId,
      providerId: provider.id,
      feature: 'report_params',
      success: false,
      errorMessage: err instanceof Error ? err.message : 'unknown',
      appUserId: args.actorAppUserId ?? null,
      latencyMs: Date.now() - started,
    });
    return { ok: false, status: 502, error: 'ai_provider_failed' };
  }
}

/** Whether AI support chat is usable for a firm (provider wired + opted in). */
export async function kbChatAvailable(deps: AiRoutesDeps, firmId: string): Promise<boolean> {
  if (!firmOptedIn()) return false;
  const provider = await pickProvider(deps, 'support-chat', firmId);
  return Boolean(provider);
}
