// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// AI-feature endpoints (Phase 23). Description suggestion + plain-English
// realization narrative. Provider routing prefers local (Ollama) and
// falls back to cloud per @vibe/core/ai. Budget check (Q14) happens
// before every call; exhausted budgets return 402 with a clear message.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, sql, sum } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { aiRequestLog, firmSettings } from '@vibe/db/schema';
import { checkBudget, type AiProvider } from '@vibe/core/ai';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface AiRoutesDeps extends RbacDeps {
  db: Database | null;
  // Caller picks which provider is preferred; routing logic lives here.
  cloudProvider?: AiProvider | null;
  localProvider?: AiProvider | null;
  /** Override the wall clock for deterministic tests. */
  now?: () => Date;
}

const DescribeSchema = z.object({
  engagementName: z.string().max(200).optional(),
  workCodeName: z.string().max(120).optional(),
  hours: z.number().positive().max(24).optional(),
  context: z.string().max(2000).optional(),
});

const NarrativeSchema = z.object({
  realizationPct: z.number(),
  topDrivers: z.array(z.string()).max(20).optional(),
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
    async (_req: Request, res: Response) => {
      const provider = await pickProvider(deps);
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
      const provider = await pickProvider(deps, 'suggest-description');
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
      let result;
      try {
        result = await provider.complete({
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
      const provider = await pickProvider(deps, 'realization-narrative');
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
      const provider = await pickProvider(deps, 'plain-english-query');
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
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'pricing-suggestion');
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
      const provider = await pickProvider(deps, 'write-down-patterns');
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
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const provider = await pickProvider(deps, 'reason-code-suggest');
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
      const provider = await pickProvider(deps, 'prebill-narrative');
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
      const provider = await pickProvider(deps, 'anomaly-summary');
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
      const provider = await pickProvider(deps, 'nl-to-filter');
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
      const provider = await pickProvider(deps, 'scope-creep-narrative');
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
      const provider = await pickProvider(deps, 'capacity-narrative');
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
      const userId = typeof req.query['appUserId'] === 'string' ? req.query['appUserId'] : null;
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

async function pickProvider(deps: AiRoutesDeps, feature?: string): Promise<AiProvider | null> {
  const override = featureOverride(feature);
  if (override === 'cloud') return deps.cloudProvider ?? deps.localProvider ?? null;
  if (override === 'local') return deps.localProvider ?? deps.cloudProvider ?? null;
  // Q15 — local preferred. Falls back to cloud per-feature.
  return deps.localProvider ?? deps.cloudProvider ?? null;
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
  appUserId: string;
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
    } as const
  )[args.providerId as 'anthropic' | 'ollama' | 'openai_compatible'];
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
