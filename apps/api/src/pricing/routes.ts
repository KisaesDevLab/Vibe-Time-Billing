// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Pricing-suggestion API (PS Phases 8 + 10). Compute an on-demand suggestion for
// an engagement (engine + Tier-2 + rationale), record the accept/edit/override
// decision (audit-only; no fee written), and refresh the live economic index.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements, firmSettings, pricingDecisions } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission } from '../auth/rbac-middleware';
import { runAiCompletion, type AiRoutesDeps } from '../ai/routes';
import { computePricingSuggestion, type PricingSettingsRow } from './service';
import { refreshEconomicIndex } from './economic';
import type { AiComplete } from './rationale';

const TIER = z.enum(['PARTNER', 'MANAGER', 'REVIEWER', 'PREPARER', 'STAFF']);

const OverridesSchema = z
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
  .optional();

const SuggestionSchema = z.object({ overrides: OverridesSchema });

const DecisionSchema = z.object({
  action: z.enum(['ACCEPTED', 'EDITED', 'OVERRIDDEN']),
  overrides: OverridesSchema,
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

      // No persistence here — live recompute would spam rows. The decision
      // endpoint recomputes authoritatively and writes one audit row.
      res.json({ suggestion });
    },
  );

  // Record the CPA's accept/edit/override. Recomputes server-side (tamper-proof
  // snapshot) and writes one pricing_decision row. No engagement fee is written.
  router.post(
    '/engagements/:id/decision',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const parsed = DecisionSchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      const { firmId, appUserId } = req.staffSession!;
      const engagementId = req.params['id']!;
      const owner = await loadEngagementFirm(deps.db, engagementId);
      if (owner !== firmId) return void res.status(404).json({ error: 'not_found' });

      const settings = await loadSettings(deps.db, firmId);
      const s = await computePricingSuggestion(deps.db, {
        firmId,
        engagementId,
        settings,
        overrides: parsed.data.overrides,
        aiComplete: null, // no AI spend just to log a decision
      });
      const finalLow = parsed.data.finalLowCents ?? s.price.lowCents;
      const finalHigh = parsed.data.finalHighCents ?? s.price.highCents;

      const [decision] = await deps.db
        .insert(pricingDecisions)
        .values({
          firmId,
          engagementId,
          inputsJson: {
            tiers: s.price.breakdownByTier,
            costBaseCents: s.price.costBaseCents,
            grossedUpCents: s.price.grossedUpCents,
            targetMarginPct: s.price.targetMarginPct,
            economic: s.economic,
            mode: s.price.mode,
            cohortSize: s.cohortSize,
            complexity: s.complexity,
            signals: s.signals,
          },
          suggestedLowCents: s.price.lowCents,
          suggestedHighCents: s.price.highCents,
          economicSource: s.economic.source,
          economicAsOf: s.economic.asOf,
          confidence: s.price.confidence,
          userAction: parsed.data.action,
          finalLowCents: finalLow,
          finalHighCents: finalHigh,
          decidedByAppUserId: appUserId,
          decidedAt: new Date(),
          createdByAppUserId: appUserId,
        })
        .returning({ id: pricingDecisions.id });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'pricing_decision',
        entityId: decision!.id,
        actorAppUserId: appUserId,
        after: {
          userAction: parsed.data.action,
          suggestedLowCents: s.price.lowCents,
          suggestedHighCents: s.price.highCents,
          finalLowCents: finalLow,
          finalHighCents: finalHigh,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      res.json({ ok: true, decisionId: decision!.id });
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
