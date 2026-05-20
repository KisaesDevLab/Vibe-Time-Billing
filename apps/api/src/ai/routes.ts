// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// AI-feature endpoints (Phase 23). Description suggestion + plain-English
// realization narrative. Provider routing prefers local (Ollama) and
// falls back to cloud per @vibe/core/ai. Budget check (Q14) happens
// before every call; exhausted budgets return 402 with a clear message.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, sum } from 'drizzle-orm';

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
