// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4a — Proposal CRUD staff API (ADDENDUM-PROPOSAL-MODULE.md §P04).
//
// Mounted at /api/staff/proposals. Pure CRUD on the header + the
// brochure_jsonb block tree. Block-type behavior (services-block
// materialization into proposal_line_items) lands in P05 alongside
// each block type's editor. Versioning + send + accept land in P06+.
//
// Endpoints:
//   GET    /                  — list filtered by status + client
//   GET    /:id               — detail including brochureJsonb
//   POST   /                  — create draft proposal
//   PATCH  /:id               — update header fields (title only in v1)
//   POST   /:id/brochure      — replace brochureJsonb (block tree).
//                               Bumps draft_revision. Rejects if
//                               status is not DRAFT.
//   POST   /:id/archive       — soft cancel: status → CANCELLED,
//                               cancelled_at + cancelled_by_id set.
//                               Refuses if already SIGNED / ACCEPTED
//                               (those need a different lifecycle).
//
// Every mutation emits an audit_log row.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clients, proposalVersions, proposals } from '@vibe/db/schema';
import { contentHash, isBlockTree, type ProposalBlockTree } from '@vibe/core/proposals';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface ProposalRoutesDeps extends RbacDeps {
  db: Database | null;
}

const STATUSES = [
  'DRAFT',
  'SENT',
  'VIEWED',
  'IN_PROGRESS',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'COUNTERED',
] as const;
type Status = (typeof STATUSES)[number];

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(1).max(240),
});

const PatchSchema = z.object({
  title: z.string().min(1).max(240).optional(),
});

const BrochureSchema = z.object({
  brochureJsonb: z.unknown(),
});

export function createProposalRouter(deps: ProposalRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'proposal:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const conds = [eq(proposals.firmId, session.firmId)];
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    if (status && (STATUSES as readonly string[]).includes(status)) {
      conds.push(eq(proposals.status, status as Status));
    }
    const clientId = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : null;
    if (clientId && /^[0-9a-f-]{36}$/i.test(clientId)) {
      conds.push(eq(proposals.clientId, clientId));
    }
    const items = await deps.db
      .select({
        id: proposals.id,
        firmId: proposals.firmId,
        clientId: proposals.clientId,
        status: proposals.status,
        title: proposals.title,
        totalOneTimeCents: proposals.totalOneTimeCents,
        totalRecurringCents: proposals.totalRecurringCents,
        recurringInterval: proposals.recurringInterval,
        sentAt: proposals.sentAt,
        expiresAt: proposals.expiresAt,
        firstViewedAt: proposals.firstViewedAt,
        acceptedAt: proposals.acceptedAt,
        declinedAt: proposals.declinedAt,
        cancelledAt: proposals.cancelledAt,
        draftRevision: proposals.draftRevision,
        createdAt: proposals.createdAt,
        updatedAt: proposals.updatedAt,
        clientName: clients.name,
      })
      .from(proposals)
      .leftJoin(clients, eq(clients.id, proposals.clientId))
      .where(and(...conds))
      .orderBy(desc(proposals.updatedAt))
      .limit(500);
    res.json({ items });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'proposal:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ proposal: row });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(proposals)
        .values({
          firmId: session.firmId,
          clientId: parsed.data.clientId,
          status: 'DRAFT',
          title: parsed.data.title,
          brochureJsonb: { blocks: [], schemaVersion: 1 } as unknown as Record<string, unknown>,
          createdById: session.appUserId,
        })
        .returning({ id: proposals.id });
      if (!row) throw new Error('proposal_insert_failed');
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'proposal',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { title: parsed.data.title, clientId: parsed.data.clientId },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.status !== 'DRAFT') {
        res.status(409).json({ error: 'not_editable', currentStatus: prior.status });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.title != null) patch['title'] = parsed.data.title;
      await deps.db.update(proposals).set(patch).where(eq(proposals.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'proposal',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: patch,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/brochure',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = BrochureSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!isBlockTree(parsed.data.brochureJsonb)) {
        res.status(400).json({ error: 'invalid_block_tree' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.status !== 'DRAFT') {
        res.status(409).json({ error: 'not_editable', currentStatus: prior.status });
        return;
      }
      const nextRevision = prior.draftRevision + 1;
      await deps.db
        .update(proposals)
        .set({
          brochureJsonb: parsed.data.brochureJsonb as unknown as Record<string, unknown>,
          draftRevision: nextRevision,
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'proposal.brochure',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: { draftRevision: prior.draftRevision },
        after: { draftRevision: nextRevision },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, draftRevision: nextRevision });
    },
  );

  router.post(
    '/:id/archive',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status === 'ACCEPTED' || row.status === 'CANCELLED') {
        res.status(409).json({ error: 'not_archivable', currentStatus: row.status });
        return;
      }
      const now = new Date();
      await deps.db
        .update(proposals)
        .set({
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledById: session.appUserId,
          updatedAt: now,
        })
        .where(eq(proposals.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'proposal',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { status: row.status },
        after: { status: 'CANCELLED' },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // P06 — send the proposal. Snapshots the current draft as
  // proposal_versions row v1 with a SHA-256 content hash and
  // transitions DRAFT → SENT. Re-sending an already-SENT proposal
  // is a no-op for v1 (a "resend" UX comes later with magic-link
  // regeneration in P17).
  const SendSchema = z.object({
    expiresAt: z.string().datetime().nullable().optional(),
  });
  router.post(
    '/:id/send',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = SendSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.status !== 'DRAFT') {
        res.status(409).json({ error: 'not_sendable', currentStatus: prior.status });
        return;
      }
      // The next version number — should always be 1 for a first
      // send, but guard against partial states where a version
      // already exists.
      const existing = await deps.db
        .select({ version: proposalVersions.version })
        .from(proposalVersions)
        .where(eq(proposalVersions.proposalId, prior.id));
      const nextVersion =
        existing.length === 0 ? 1 : Math.max(...existing.map((r) => r.version)) + 1;
      const snapshot = {
        title: prior.title,
        brochureJsonb: prior.brochureJsonb as ProposalBlockTree | Record<string, unknown>,
        totalOneTimeCents: Number(prior.totalOneTimeCents),
        totalRecurringCents: Number(prior.totalRecurringCents),
        recurringInterval: prior.recurringInterval,
        // line items + packages snapshots land here once those
        // surfaces ship; for now the brochure tree is the
        // authoritative copy.
        proposalLineItems: [] as unknown[],
        proposalPackages: [] as unknown[],
      };
      const hash = contentHash(snapshot);
      const sentAt = new Date();
      await deps.db.insert(proposalVersions).values({
        proposalId: prior.id,
        version: nextVersion,
        contentJsonb: snapshot as unknown as Record<string, unknown>,
        contentHash: hash,
        reason: 'SENT',
        createdById: session.appUserId,
      });
      await deps.db
        .update(proposals)
        .set({
          status: 'SENT',
          sentAt,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
          updatedAt: sentAt,
        })
        .where(eq(proposals.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'proposal',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: { status: 'DRAFT' },
        after: { status: 'SENT', version: nextVersion, hash },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, version: nextVersion, contentHash: hash });
    },
  );

  // P06 — list snapshots for a proposal.
  router.get(
    '/:id/versions',
    requirePermission(deps, 'proposal:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [prior] = await deps.db
        .select({ id: proposals.id })
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select({
          id: proposalVersions.id,
          version: proposalVersions.version,
          contentHash: proposalVersions.contentHash,
          reason: proposalVersions.reason,
          createdAt: proposalVersions.createdAt,
          createdById: proposalVersions.createdById,
        })
        .from(proposalVersions)
        .where(eq(proposalVersions.proposalId, prior.id))
        .orderBy(asc(proposalVersions.version));
      res.json({ items });
    },
  );

  // P06 — fetch a specific snapshot's contents (firm-only).
  router.get(
    '/:id/versions/:version',
    requirePermission(deps, 'proposal:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const versionNum = Number(req.params['version']);
      if (!Number.isInteger(versionNum) || versionNum < 1) {
        res.status(400).json({ error: 'invalid_version' });
        return;
      }
      const [prior] = await deps.db
        .select({ id: proposals.id })
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(proposalVersions)
        .where(
          and(eq(proposalVersions.proposalId, prior.id), eq(proposalVersions.version, versionNum)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ version: row });
    },
  );

  return router;
}
