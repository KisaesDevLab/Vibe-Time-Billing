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

export function createAiRouter(deps: AiRoutesDeps): Router {
  const router = express.Router();
  const now = deps.now ?? (() => new Date());

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
      const provider = await pickProvider(deps);
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
      const provider = await pickProvider(deps);
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
      const provider = await pickProvider(deps);
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
        res.json({ answer: result.text.trim(), providerId: result.providerId });
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
      const provider = await pickProvider(deps);
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
      const provider = await pickProvider(deps);
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
      const provider = await pickProvider(deps);
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
      const provider = await pickProvider(deps);
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

async function pickProvider(deps: AiRoutesDeps): Promise<AiProvider | null> {
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
