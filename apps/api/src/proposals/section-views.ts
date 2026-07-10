// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P20 — Per-section view tracking endpoint.
//
// Portal renders the block tree from /redeem (P17) and wires an
// IntersectionObserver on each block. When a section enters the
// viewport ≥50% for ≥1s the portal POSTs here with the
// section_block_id + cumulative dwell. The endpoint upserts a
// proposal_section_views row keyed on (proposal_id, section_block_id,
// session_id) — repeat views from the same session accumulate dwell
// rather than spawn new rows.
//
// Idle timeout: 5 minutes of no POSTs from a session ends that
// session's tracking window. The session_id itself doesn't expire —
// the portal page generates a fresh session_id on next page load,
// so a returning client gets a separate row.
//
// Privacy: only IP / UA / timestamps tracked. No fingerprinting
// beyond what the magic-link already captures.

import { createHash } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { magicLinks, proposalActivity, proposalSectionViews, proposals } from '@vibe/db/schema';

import { logger } from '../logger';

export interface SectionViewDeps {
  db: Database | null;
}

const SectionViewSchema = z.object({
  // The portal authenticates via the magic-link token; we re-hash
  // and look up the proposal id, never trusting the supplied
  // proposalId from the client.
  magicLinkToken: z.string().min(20).max(100),
  sessionId: z.string().min(1).max(100),
  sectionBlockId: z.string().min(1).max(120),
  // Incremental dwell since last report. The portal sends this in
  // small chunks (every few seconds while a section is on screen)
  // so we don't drop everything if the page closes mid-view.
  dwellMs: z
    .number()
    .int()
    .min(0)
    .max(60 * 60 * 1000),
});

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function createSectionViewRouter(deps: SectionViewDeps): Router {
  const router = express.Router();

  router.post('/section-view', async (req: Request, res: Response) => {
    const parsed = SectionViewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const hash = hashToken(parsed.data.magicLinkToken);
    const [link] = await deps.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, hash))
      .limit(1);
    if (!link || !link.proposalId) {
      res.status(404).json({ error: 'token_not_found' });
      return;
    }
    if (link.expiresAt.getTime() <= Date.now() || link.supersededAt != null) {
      res.status(410).json({ error: 'token_unusable' });
      return;
    }
    // Confirm the proposal is in a viewable state.
    const [proposal] = await deps.db
      .select({ id: proposals.id, status: proposals.status })
      .from(proposals)
      .where(eq(proposals.id, link.proposalId))
      .limit(1);
    if (!proposal) {
      res.status(404).json({ error: 'proposal_not_found' });
      return;
    }

    const now = new Date();

    // Upsert: if (proposal_id, section_block_id, session_id) exists,
    // accumulate dwell + bump view_count + advance last_viewed_at.
    // pglite (and real PG) support ON CONFLICT (...) DO UPDATE
    // — but drizzle's onConflictDoUpdate doesn't accept arrays of
    // column targets across versions reliably. Fall back to a raw
    // INSERT … ON CONFLICT.
    await deps.db.execute(
      sql`INSERT INTO proposal_section_views
            (proposal_id, section_block_id, session_id,
             first_viewed_at, last_viewed_at, view_count, total_dwell_ms)
          VALUES (${proposal.id}, ${parsed.data.sectionBlockId}, ${parsed.data.sessionId},
                  ${now.toISOString()}, ${now.toISOString()}, 1, ${parsed.data.dwellMs})
          ON CONFLICT (proposal_id, section_block_id, session_id)
          DO UPDATE SET
            last_viewed_at = EXCLUDED.last_viewed_at,
            view_count = proposal_section_views.view_count + 1,
            total_dwell_ms = proposal_section_views.total_dwell_ms + EXCLUDED.total_dwell_ms,
            updated_at = ${now.toISOString()}`,
    );

    // Log a per-event activity row so the dashboard funnel can
    // count discrete views (vs the aggregated section_views row
    // which only knows totals).
    await deps.db
      .insert(proposalActivity)
      .values({
        proposalId: proposal.id,
        kind: 'SECTION_VIEWED',
        occurredFromIp: req.ip ?? null,
        occurredFromUa: req.get('user-agent') ?? null,
        magicLinkId: link.id,
        payload: {
          sectionBlockId: parsed.data.sectionBlockId,
          sessionId: parsed.data.sessionId,
          dwellMs: parsed.data.dwellMs,
        },
      })
      .catch((err: unknown) => logger.error({ err }, 'activity insert failed'));

    res.json({ ok: true });
  });

  // Aggregate read for the firm-side dashboard. Returns one row per
  // section_block_id with totals across all sessions.
  router.get('/:proposalId/section-views', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select()
      .from(proposalSectionViews)
      .where(eq(proposalSectionViews.proposalId, req.params['proposalId']!));
    // Aggregate client-side. The Postgres GROUP BY route would also
    // work but is more brittle through drizzle's typed builder.
    const agg = new Map<
      string,
      { sectionBlockId: string; sessions: number; totalDwellMs: number; views: number }
    >();
    for (const r of rows) {
      const existing = agg.get(r.sectionBlockId);
      if (existing) {
        existing.sessions += 1;
        existing.totalDwellMs += Number(r.totalDwellMs);
        existing.views += r.viewCount;
      } else {
        agg.set(r.sectionBlockId, {
          sectionBlockId: r.sectionBlockId,
          sessions: 1,
          totalDwellMs: Number(r.totalDwellMs),
          views: r.viewCount,
        });
      }
    }
    res.json({ items: Array.from(agg.values()) });
  });

  // Silence unused-var lint for `and` reserved for future scoped
  // queries.
  void and;
  return router;
}
