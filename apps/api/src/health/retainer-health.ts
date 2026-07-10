// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// R6-followup — retainer health + metrics surface.
//
//   GET  /health/retainers   — 200 when the daily sweeps ran in the
//     last 25h, 503 otherwise (signals that the worker isn't picking
//     up retainer-expiry-sweep / retainer-offer-expiry-sweep).
//
//   GET  /metrics/retainers  — Prometheus-formatted gauges for the
//     current retainer surface, mountable behind the existing /metrics
//     endpoint via collectRetainerMetricsText().
//
// Sweep heartbeat uses Redis keys the worker sets after each sweep
// completes:
//   retainer:sweep:expiry:last_run    ISO timestamp
//   retainer:sweep:offer:last_run     ISO timestamp
// 25h is the staleness budget — sweeps run daily at 02:00/02:15 UTC,
// so missing a full day is the signal.

import { count, eq, gte, sql, sum } from 'drizzle-orm';
import type { Express, Request, Response } from 'express';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { retainerOffers, retainers } from '@vibe/db/schema';

const STALENESS_MS = 25 * 3600_000;

export interface RetainerHealthDeps {
  db: Database | null;
  redis: Redis;
}

export const SWEEP_HEARTBEAT_KEY_EXPIRY = 'retainer:sweep:expiry:last_run';
export const SWEEP_HEARTBEAT_KEY_OFFER = 'retainer:sweep:offer:last_run';

export function mountRetainerHealth(app: Express, deps: RetainerHealthDeps): void {
  app.get('/health/retainers', async (_req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ status: 'no_db', service: 'retainers' });
      return;
    }
    const now = Date.now();
    let expiryAt: string | null = null;
    let offerAt: string | null = null;
    try {
      expiryAt = await deps.redis.get(SWEEP_HEARTBEAT_KEY_EXPIRY);
      offerAt = await deps.redis.get(SWEEP_HEARTBEAT_KEY_OFFER);
    } catch (err) {
      res.status(503).json({
        status: 'redis_down',
        service: 'retainers',
        error: err instanceof Error ? err.message : '?',
      });
      return;
    }
    const expiryAgeMs = expiryAt ? now - new Date(expiryAt).getTime() : Number.POSITIVE_INFINITY;
    const offerAgeMs = offerAt ? now - new Date(offerAt).getTime() : Number.POSITIVE_INFINITY;
    const expiryFresh = expiryAgeMs < STALENESS_MS;
    const offerFresh = offerAgeMs < STALENESS_MS;
    const ok = expiryFresh && offerFresh;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'stale',
      service: 'retainers',
      lastExpirySweep: expiryAt,
      lastOfferSweep: offerAt,
      stalenessLimitHours: STALENESS_MS / 3600_000,
    });
  });
}

/**
 * Resolves the five retainer gauges in a single DB round-trip per query
 * (the sums and counts are independent so we run them in parallel via
 * Promise.all). Returns text in Prometheus exposition format so the
 * main /metrics handler can append directly.
 */
export async function collectRetainerMetricsText(db: Database): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const in30Days = new Date(Date.now() + 30 * 24 * 3600_000).toISOString().slice(0, 10);
  const [
    [activeRow],
    [hoursRemainingRow],
    [expiring30Row],
    [offersPendingRow],
    [deferredLiabilityRow],
  ] = await Promise.all([
    db.select({ c: count() }).from(retainers).where(eq(retainers.status, 'active')),
    db
      .select({
        s: sql<string>`COALESCE(SUM(${retainers.hoursPurchased} - ${retainers.hoursConsumed}), 0)`,
      })
      .from(retainers)
      .where(eq(retainers.status, 'active')),
    db
      .select({ c: count() })
      .from(retainers)
      .where(
        sql`${retainers.status} = 'active' AND ${retainers.expiryDate} <= ${in30Days} AND ${retainers.expiryDate} >= ${today}`,
      ),
    db.select({ c: count() }).from(retainerOffers).where(eq(retainerOffers.status, 'pending')),
    db
      .select({
        s: sql<string>`COALESCE(SUM(${retainers.priceCents} * (${retainers.hoursPurchased} - ${retainers.hoursConsumed}) / NULLIF(${retainers.hoursPurchased}, 0)), 0)`,
      })
      .from(retainers)
      .where(eq(retainers.status, 'active')),
  ]);

  const lines: string[] = [];
  lines.push('# HELP retainer_active_count Active retainers across all clients.');
  lines.push('# TYPE retainer_active_count gauge');
  lines.push(`retainer_active_count{service="api"} ${activeRow?.c ?? 0}`);

  lines.push('# HELP retainer_hours_remaining_total Sum of remaining hours on active retainers.');
  lines.push('# TYPE retainer_hours_remaining_total gauge');
  lines.push(`retainer_hours_remaining_total{service="api"} ${Number(hoursRemainingRow?.s ?? 0)}`);

  lines.push('# HELP retainer_expiring_30d Active retainers expiring within 30 days.');
  lines.push('# TYPE retainer_expiring_30d gauge');
  lines.push(`retainer_expiring_30d{service="api"} ${expiring30Row?.c ?? 0}`);

  lines.push('# HELP retainer_offers_pending Pending offers waiting on client action.');
  lines.push('# TYPE retainer_offers_pending gauge');
  lines.push(`retainer_offers_pending{service="api"} ${offersPendingRow?.c ?? 0}`);

  lines.push(
    '# HELP retainer_deferred_liability_cents Pro-rated value of unconsumed retainer hours (active).',
  );
  lines.push('# TYPE retainer_deferred_liability_cents gauge');
  lines.push(
    `retainer_deferred_liability_cents{service="api"} ${Math.round(Number(deferredLiabilityRow?.s ?? 0))}`,
  );
  return lines.join('\n');
}

void sum;
void gte;
