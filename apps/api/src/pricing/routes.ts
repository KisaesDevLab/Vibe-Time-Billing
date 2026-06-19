// SPDX-License-Identifier: Elastic-2.0
//
// Pricing-suggestion API (PS Phases 8 + 10). Compute an on-demand suggestion for
// an engagement (engine + Tier-2 + rationale), record the accept/edit/override
// decision (audit-only; no fee written), and refresh the live economic index.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements, firmSettings, pricingDecisions } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission } from '../auth/rbac-middleware';
import { runAiCompletion, type AiRoutesDeps } from '../ai/routes';
import { computePricingSuggestion, type PricingSettingsRow } from './service';
import { refreshEconomicIndex } from './economic';
import type { AiComplete } from './rationale';

const TIER = z.enum(['PARTNER', 'MANAGER', 'REVIEWER', 'PREPARER', 'STAFF']);

const SuggestionSchema = z.object({
  overrides: z
    .object({
      tiers: z
        .array(
          z.object({
            tier: TIER,
            expectedHours: z.number().nonnegative().max(100000).optional(),
            burdenedCostRateCents: z.number().int().nonnegative().max(10_000_00).optional(),
          }),
        )
        .optional(),
      targetMarginPct: z.number().min(0).max(99.99).optional(),
      economicFactorPct: z.number().min(-50).max(100).optional(),
    })
    .optional(),
});

const DecisionSchema = z.object({
  decisionId: z.string().uuid(),
  action: z.enum(['ACCEPTED', 'EDITED', 'OVERRIDDEN']),
  finalLowCents: z.number().int().nonnegative().optional(),
  finalHighCents: z.number().int().nonnegative().optional(),
});

const PRICING_COLS = {
  pricingEconomicSource: firmSettings.pricingEconomicSource,
  pricingEconomicManualPct: firmSettings.pricingEconomicManualPct,
  pricingTargetMarginPct: firmSettings.pricingTargetMarginPct,
  pricingExpectedHoursStat: firmSettings.pricingExpectedHoursStat,
  pricingCohortMin: firmSettings.pricingCohortMin,
  pricingBurdenedCostPerTier: firmSettings.pricingBurdenedCostPerTier,
};

export function createPricingRouter(deps: AiRoutesDeps): Router {
  const router = express.Router();

  // Confirm the engagement belongs to the caller's firm.
  async function loadEngagementFirm(db: Database, engagementId: string): Promise<string | null> {
    const [row] = await db
      .select({ firmId: clients.firmId })
      .from(engagements)
      .innerJoin(clients, eq(clients.id, engagements.clientId))
      .where(eq(engagements.id, engagementId))
      .limit(1);
    return row?.firmId ?? null;
  }

  async function loadSettings(db: Database, firmId: string): Promise<PricingSettingsRow> {
    const [row] = await db
      .select(PRICING_COLS)
      .from(firmSettings)
      .where(eq(firmSettings.firmId, firmId))
      .limit(1);
    return {
      pricingEconomicSource: row?.pricingEconomicSource ?? 'MANUAL',
      pricingEconomicManualPct: row?.pricingEconomicManualPct ?? '0',
      pricingTargetMarginPct: row?.pricingTargetMarginPct ?? '40',
      pricingExpectedHoursStat:
        (row?.pricingExpectedHoursStat as 'TRIMMED_MEAN' | 'MEDIAN') ?? 'TRIMMED_MEAN',
      pricingCohortMin: row?.pricingCohortMin ?? 5,
      pricingBurdenedCostPerTier: row?.pricingBurdenedCostPerTier ?? {},
    };
  }

  // Compute a suggestion (and persist a PENDING decision snapshot).
  router.post(
    '/engagements/:id/suggestion',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const parsed = SuggestionSchema.safeParse(req.body ?? {});
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      const { firmId, appUserId } = req.staffSession!;
      const engagementId = req.params['id']!;
      const owner = await loadEngagementFirm(deps.db, engagementId);
      if (owner !== firmId) return void res.status(404).json({ error: 'not_found' });

      const settings = await loadSettings(deps.db, firmId);
      const aiComplete: AiComplete = async (systemPrompt, userPrompt) => {
        const text = await runAiCompletion(deps, {
          firmId,
          appUserId,
          feature: 'pricing-rationale',
          systemPrompt,
          userPrompt,
          maxTokens: 240,
        });
        if (text == null) throw new Error('ai_unavailable');
        return text;
      };

      const suggestion = await computePricingSuggestion(deps.db, {
        firmId,
        engagementId,
        settings,
        overrides: parsed.data.overrides,
        aiComplete,
      });

      const [decision] = await deps.db
        .insert(pricingDecisions)
        .values({
          firmId,
          engagementId,
          inputsJson: {
            tiers: suggestion.price.breakdownByTier,
            costBaseCents: suggestion.price.costBaseCents,
            grossedUpCents: suggestion.price.grossedUpCents,
            targetMarginPct: suggestion.price.targetMarginPct,
            economic: suggestion.economic,
            mode: suggestion.price.mode,
            cohortSize: suggestion.cohortSize,
            complexity: suggestion.complexity,
            signals: suggestion.signals,
          },
          suggestedLowCents: suggestion.price.lowCents,
          suggestedHighCents: suggestion.price.highCents,
          suggestedRationale: suggestion.rationale.text,
          rationaleSource: suggestion.rationale.source,
          economicSource: suggestion.economic.source,
          economicAsOf: suggestion.economic.asOf,
          confidence: suggestion.price.confidence,
          createdByAppUserId: appUserId,
        })
        .returning({ id: pricingDecisions.id });

      res.json({ decisionId: decision!.id, suggestion });
    },
  );

  // Record the CPA's accept/edit/override (no engagement fee is written).
  router.post(
    '/engagements/:id/decision',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const parsed = DecisionSchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      const { firmId, appUserId } = req.staffSession!;
      const engagementId = req.params['id']!;

      const [existing] = await deps.db
        .select()
        .from(pricingDecisions)
        .where(
          and(eq(pricingDecisions.id, parsed.data.decisionId), eq(pricingDecisions.firmId, firmId)),
        )
        .limit(1);
      if (!existing || existing.engagementId !== engagementId)
        return void res.status(404).json({ error: 'not_found' });

      await deps.db
        .update(pricingDecisions)
        .set({
          userAction: parsed.data.action,
          finalLowCents: parsed.data.finalLowCents ?? existing.suggestedLowCents,
          finalHighCents: parsed.data.finalHighCents ?? existing.suggestedHighCents,
          decidedByAppUserId: appUserId,
          decidedAt: new Date(),
        })
        .where(eq(pricingDecisions.id, existing.id));

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'pricing_decision',
        entityId: existing.id,
        actorAppUserId: appUserId,
        before: {
          userAction: existing.userAction,
          suggestedLowCents: existing.suggestedLowCents,
          suggestedHighCents: existing.suggestedHighCents,
        },
        after: {
          userAction: parsed.data.action,
          finalLowCents: parsed.data.finalLowCents ?? existing.suggestedLowCents,
          finalHighCents: parsed.data.finalHighCents ?? existing.suggestedHighCents,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      res.json({ ok: true });
    },
  );

  // Refresh the live economic index for the firm (egress-gated upstream).
  router.post(
    '/economic-refresh',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const parsed = z.object({ source: z.enum(['CPI', 'ECI']) }).safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      const { firmId } = req.staffSession!;
      try {
        const factor = await refreshEconomicIndex(deps.db, { firmId, source: parsed.data.source });
        res.json({ ok: true, factor });
      } catch (err) {
        res
          .status(502)
          .json({ error: 'fetch_failed', detail: err instanceof Error ? err.message : 'unknown' });
      }
    },
  );

  return router;
}
