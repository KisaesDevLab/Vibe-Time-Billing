// SPDX-License-Identifier: Elastic-2.0
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
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clients,
  packages,
  proposalPackages,
  proposalVersions,
  proposals,
  signatures,
} from '@vibe/db/schema';
import { isBlockTree, type ProposalBlockTree } from '@vibe/core/proposals';
import { contentHash } from '@vibe/core/proposals/server';

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
  createEngagementOnAccept: z.boolean().optional(),
  requestTemplateIdOnAccept: z.string().uuid().nullable().optional(),
});

const BrochureSchema = z.object({
  brochureJsonb: z.unknown(),
});

/**
 * Collect the package names referenced by `package_selector` blocks in a
 * brochure block tree, in document order, de-duplicated.
 */
function packageNamesFromBrochure(brochure: unknown): string[] {
  const tree = brochure as { blocks?: { type?: string; props?: Record<string, unknown> }[] };
  const blocks = Array.isArray(tree?.blocks) ? tree.blocks : [];
  const names: string[] = [];
  for (const b of blocks) {
    if (b?.type !== 'package_selector') continue;
    const name = String(b.props?.['packageName'] ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Snapshot the packages a proposal offers into proposal_packages, so the
 * client's tier choice (selected=true) and the scope freeze have concrete
 * rows to bind to. Each `package_selector` block names a package whose tiers
 * are individual packages rows; we insert one proposal_packages row per tier.
 *
 * Idempotent per send: clears the proposal's existing offer rows first (a send
 * only happens from DRAFT, so none can be selected yet) and re-inserts from the
 * current brochure.
 */
async function syncProposalPackages(
  db: Database,
  proposalId: string,
  firmId: string,
  brochure: unknown,
): Promise<void> {
  const names = packageNamesFromBrochure(brochure);
  await db.delete(proposalPackages).where(eq(proposalPackages.proposalId, proposalId));
  if (names.length === 0) return;
  const rows = await db
    .select({ id: packages.id, name: packages.name, position: packages.position })
    .from(packages)
    .where(and(eq(packages.firmId, firmId), inArray(packages.name, names)));
  if (rows.length === 0) return;
  // Order by the brochure's block order, then by tier position within a name.
  const ordered = rows.sort((a, b) => {
    const ai = names.indexOf(a.name);
    const bi = names.indexOf(b.name);
    return ai !== bi ? ai - bi : a.position - b.position;
  });
  await db.insert(proposalPackages).values(
    ordered.map((p, i) => ({
      proposalId,
      packageId: p.id,
      sequence: i,
    })),
  );
}

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
    // Free-text search across proposal title + client name.
    const q = (req.query['q'] ?? '').toString().trim();
    if (q) {
      const like = `%${q}%`;
      const expr = or(ilike(proposals.title, like), ilike(clients.name, like));
      if (expr) conds.push(expr);
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
        createdById: proposals.createdById,
        createdByName: appUsers.fullName,
      })
      .from(proposals)
      .leftJoin(clients, eq(clients.id, proposals.clientId))
      .leftJoin(appUsers, eq(appUsers.id, proposals.createdById))
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
      // Offered package tiers + which one the client selected, so staff can
      // see the chosen tier on an accepted proposal.
      const offeredPackages = await deps.db
        .select({
          packageId: proposalPackages.packageId,
          name: packages.name,
          tierLabel: packages.tierLabel,
          priceOverrideCents: packages.priceOverrideCents,
          sequence: proposalPackages.sequence,
          selected: proposalPackages.selected,
          selectedAt: proposalPackages.selectedAt,
        })
        .from(proposalPackages)
        .innerJoin(packages, eq(packages.id, proposalPackages.packageId))
        .where(eq(proposalPackages.proposalId, row.id))
        .orderBy(asc(proposalPackages.sequence));
      const selectedPackage =
        offeredPackages.find((o) => o.selected) ??
        (row.selectedPackageId
          ? (offeredPackages.find((o) => o.packageId === row.selectedPackageId) ?? null)
          : null);
      res.json({ proposal: row, offeredPackages, selectedPackage });
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
      if (parsed.data.createEngagementOnAccept != null)
        patch['createEngagementOnAccept'] = parsed.data.createEngagementOnAccept;
      if (parsed.data.requestTemplateIdOnAccept !== undefined)
        patch['requestTemplateIdOnAccept'] = parsed.data.requestTemplateIdOnAccept;
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

  // Hard-delete a proposal (and its cascade: versions, signatures, line items,
  // packages, terms snapshot, activity, magic links). Allowed for any status
  // EXCEPT ACCEPTED — an accepted proposal is a signed record and must be kept.
  router.delete(
    '/:id',
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
      if (row.status === 'ACCEPTED') {
        res.status(409).json({ error: 'not_deletable', currentStatus: row.status });
        return;
      }
      // Audit before the row (and its cascade) is gone.
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'proposal',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { status: row.status, title: row.title, clientId: row.clientId },
        after: null,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      await deps.db
        .delete(proposals)
        .where(and(eq(proposals.id, row.id), eq(proposals.firmId, session.firmId)));
      res.json({ ok: true });
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
  // Q34 — optional signer roster. When present, the proposal becomes a
  // multi-signer proposal: one PENDING signatures row is inserted per
  // signer and acceptance gates on every required signer signing. When
  // absent, the legacy single-signer behavior is preserved (the
  // signature row is created at acceptance time).
  const SignerSchema = z.object({
    name: z.string().min(1).max(240),
    email: z.string().email().max(240),
    phone: z.string().max(40).nullable().optional(),
    role: z.enum(['PRIMARY', 'COSIGNER', 'WITNESS']).optional(),
    required: z.boolean().optional(),
  });
  const SendSchema = z.object({
    expiresAt: z.string().datetime().nullable().optional(),
    signers: z.array(SignerSchema).min(1).max(10).optional(),
    signingOrderMode: z.enum(['PARALLEL', 'SEQUENTIAL']).optional(),
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

      // Q34 — validate the signer roster (if any) before any writes.
      const signers = parsed.data.signers;
      if (signers) {
        const emails = signers.map((s) => s.email.trim().toLowerCase());
        if (new Set(emails).size !== emails.length) {
          res.status(400).json({ error: 'duplicate_signer_email' });
          return;
        }
        const requiredCount = signers.filter((s) => s.required !== false).length;
        if (requiredCount < 1) {
          res.status(400).json({ error: 'no_required_signer' });
          return;
        }
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
      const signingOrderMode = signers ? (parsed.data.signingOrderMode ?? 'PARALLEL') : 'PARALLEL';
      await deps.db
        .update(proposals)
        .set({
          status: 'SENT',
          signingOrderMode,
          sentAt,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
          updatedAt: sentAt,
        })
        .where(eq(proposals.id, prior.id));

      // Snapshot the offered packages (one row per tier) so the client's
      // selection has concrete rows to bind to and scope-freeze can resolve
      // the chosen tier's services.
      await syncProposalPackages(deps.db, prior.id, session.firmId, prior.brochureJsonb).catch(
        (err: unknown) =>
          logger.error({ err, proposalId: prior.id }, 'proposal package sync failed'),
      );

      // Q34 — insert one PENDING roster row per signer. First signer
      // defaults to PRIMARY, the rest COSIGNER; sequence follows the
      // submitted order so SEQUENTIAL signing has a stable gate.
      if (signers) {
        await deps.db.insert(signatures).values(
          signers.map((s, i) => ({
            proposalId: prior.id,
            role: s.role ?? (i === 0 ? ('PRIMARY' as const) : ('COSIGNER' as const)),
            sequence: i,
            required: s.required !== false,
            signerName: s.name,
            signerEmail: s.email,
            signerPhone: s.phone ?? null,
            method: null,
            state: 'PENDING' as const,
          })),
        );
      }

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'proposal',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: { status: 'DRAFT' },
        after: {
          status: 'SENT',
          version: nextVersion,
          hash,
          signerCount: signers?.length ?? 0,
          signingOrderMode,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({
        ok: true,
        version: nextVersion,
        contentHash: hash,
        signerCount: signers?.length ?? 0,
        signingOrderMode,
      });
    },
  );

  // Q34 — list the signer roster + signing order for a proposal (staff).
  router.get(
    '/:id/signers',
    requirePermission(deps, 'proposal:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ signers: [], signingOrderMode: 'PARALLEL' });
        return;
      }
      const [prior] = await deps.db
        .select({ id: proposals.id, signingOrderMode: proposals.signingOrderMode })
        .from(proposals)
        .where(and(eq(proposals.id, req.params['id']!), eq(proposals.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await deps.db
        .select({
          id: signatures.id,
          signerName: signatures.signerName,
          signerEmail: signatures.signerEmail,
          role: signatures.role,
          required: signatures.required,
          sequence: signatures.sequence,
          state: signatures.state,
        })
        .from(signatures)
        .where(eq(signatures.proposalId, prior.id))
        .orderBy(asc(signatures.sequence));
      res.json({ signers: rows, signingOrderMode: prior.signingOrderMode });
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
