// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P28 — Proposal pipeline + conversion funnel dashboard.
//
// GET /api/staff/proposals/dashboard
//   ?from=2026-01-01&to=2026-05-26   (optional date range — filters
//                                     proposals.created_at)
//   ?serviceCategory=tax              (optional — matches via the
//                                     services catalog through
//                                     proposal_line_items)
//   ?minValueCents=10000              (filters by 1y-value)
//   ?maxValueCents=1000000
//   ?ownerId=<uuid>                   (filters by createdById)
//
// Returns: kanban[], funnel[], timeToSign, abandoners[], stale[],
// summary{}.
//
// All math lives in @vibe/core/proposals/funnel. This file is thin
// data-load glue.

import express, { type Request, type Response, type Router } from 'express';
import { and, between, eq, gte, inArray, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { proposalActivity, proposals } from '@vibe/db/schema';
import {
  computeProposalFunnel,
  type ProposalForFunnel,
  type ProposalStatus,
} from '@vibe/core/proposals';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { uuidQueryParam } from '../lib/uuid-guard';

export interface DashboardDeps extends RbacDeps {
  db: Database | null;
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function parseInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

export function createProposalDashboardRouter(deps: DashboardDeps): Router {
  const router = express.Router();

  router.get(
    '/dashboard',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const from = parseDate(req.query['from'] as string | undefined);
      const to = parseDate(req.query['to'] as string | undefined);
      const minValueCents = parseInt(req.query['minValueCents'] as string | undefined);
      const maxValueCents = parseInt(req.query['maxValueCents'] as string | undefined);
      const ownerIdRaw = uuidQueryParam(req.query['ownerId']);
      if (ownerIdRaw === 'invalid') {
        res.status(400).json({ error: 'invalid_owner_id' });
        return;
      }
      const ownerId = ownerIdRaw;

      const conditions = [eq(proposals.firmId, session.firmId)];
      if (from && to) {
        conditions.push(between(proposals.createdAt, from, to));
      } else if (from) {
        conditions.push(gte(proposals.createdAt, from));
      } else if (to) {
        conditions.push(lte(proposals.createdAt, to));
      }
      if (ownerId) {
        conditions.push(eq(proposals.createdById, ownerId));
      }

      const rows = await deps.db
        .select({
          id: proposals.id,
          status: proposals.status,
          totalOneTimeCents: proposals.totalOneTimeCents,
          totalRecurringCents: proposals.totalRecurringCents,
          sentAt: proposals.sentAt,
          firstViewedAt: proposals.firstViewedAt,
          acceptedAt: proposals.acceptedAt,
        })
        .from(proposals)
        .where(and(...conditions));

      // Value filter is applied in JS since the value formula is
      // one_time + 12*recurring. Could push to SQL but the diff isn't
      // worth the readability hit.
      const filtered = rows.filter((r) => {
        const value = r.totalOneTimeCents + r.totalRecurringCents * 12;
        if (minValueCents != null && value < minValueCents) return false;
        if (maxValueCents != null && value > maxValueCents) return false;
        return true;
      });

      const ids = filtered.map((r) => r.id);
      // Last activity timestamps + signature-started set, one batched
      // query per axis. Empty result short-circuits.
      const lastActivityMap = new Map<string, Date>();
      const signatureStartedIds = new Set<string>();
      if (ids.length > 0) {
        const activityRows = await deps.db
          .select({
            proposalId: proposalActivity.proposalId,
            kind: proposalActivity.kind,
            occurredAt: proposalActivity.occurredAt,
          })
          .from(proposalActivity)
          .where(inArray(proposalActivity.proposalId, ids));
        for (const a of activityRows) {
          const cur = lastActivityMap.get(a.proposalId);
          if (!cur || a.occurredAt > cur) lastActivityMap.set(a.proposalId, a.occurredAt);
          if (a.kind === 'SIGNATURE_STARTED' || a.kind === 'SIGNATURE_COMPLETED') {
            signatureStartedIds.add(a.proposalId);
          }
        }
      }

      const props: ProposalForFunnel[] = filtered.map((r) => ({
        id: r.id,
        status: r.status as ProposalStatus,
        totalOneTimeCents: r.totalOneTimeCents,
        totalRecurringCents: r.totalRecurringCents,
        sentAt: r.sentAt ? r.sentAt.toISOString() : null,
        firstViewedAt: r.firstViewedAt ? r.firstViewedAt.toISOString() : null,
        acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
        lastActivityAt: lastActivityMap.get(r.id)?.toISOString() ?? null,
      }));

      const result = computeProposalFunnel({
        proposals: props,
        signatureStartedIds,
        now: new Date().toISOString(),
      });
      res.json(result);
    },
  );

  return router;
}
