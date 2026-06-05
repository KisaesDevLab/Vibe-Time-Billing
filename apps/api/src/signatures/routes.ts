// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 4 — Signatures module staff API (mounted at /api/staff/signatures).
// Request / signer / placement CRUD with authoritative server-side
// validation and a signature_events row on every mutation.
//
// Reuse note: gated on the existing proposal:read / proposal:write keys —
// signature requests are the same authoring-then-send activity as
// proposals and commit firm documents for client signature (partner-
// authored). A dedicated signature:* key can be split out later without
// touching callers (reversible).
//
// Drafts are freely editable; once a request leaves 'draft' (sent by P6)
// its signers + placements are frozen (409). The send pipeline (P6) and
// status reconciliation (P7) live in sibling files.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  signatureEvents,
  signatureFieldPlacements,
  signatureRequests,
  signatureSigners,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import type { PageGeometry } from './geometry';
import { FIELD_TYPES, validatePlacements, type PlacementInput } from './validation';

export interface SignaturesDeps extends RbacDeps {
  db: Database | null;
}

const GeometrySchema = z.array(
  z.object({
    pageNumber: z.number().int().positive(),
    widthPt: z.number().positive(),
    heightPt: z.number().positive(),
  }),
);

const SignerInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  role: z.string().trim().max(80).optional(),
  order: z.number().int().min(1).max(99).optional(),
});

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  clientId: z.string().uuid().optional(),
  formType: z.string().trim().max(40).optional(),
  sendInOrder: z.boolean().optional(),
  pageGeometry: GeometrySchema.optional(),
  signers: z.array(SignerInputSchema).min(1).max(20),
});

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  clientId: z.string().uuid().nullable().optional(),
  formType: z.string().trim().max(40).nullable().optional(),
  sendInOrder: z.boolean().optional(),
  pageGeometry: GeometrySchema.optional(),
});

const PlacementSchema = z.object({
  signerId: z.string().uuid(),
  fieldType: z.enum(FIELD_TYPES as unknown as [string, ...string[]]),
  pageNumber: z.number().int().positive(),
  nx: z.number(),
  ny: z.number(),
  nw: z.number(),
  nh: z.number(),
  required: z.boolean().optional(),
});

const PlacementsSchema = z.object({
  placements: z.array(PlacementSchema).max(500),
});

export function createSignaturesRouter(deps: SignaturesDeps): Router {
  const router = express.Router();

  // Load a firm-scoped request row (null if missing / other firm).
  async function loadRequest(db: Database, firmId: string, id: string) {
    const [row] = await db
      .select()
      .from(signatureRequests)
      .where(and(eq(signatureRequests.id, id), eq(signatureRequests.firmId, firmId)))
      .limit(1);
    return row ?? null;
  }

  // One signature_events row per mutation (the in-module audit trail; the
  // global audit_log gets a parallel emitAudit).
  async function recordEvent(
    db: Database,
    requestId: string,
    actor: string,
    event: string,
    detail?: Record<string, unknown>,
  ) {
    await db.insert(signatureEvents).values({ requestId, actor, event, detail: detail ?? null });
  }

  // GET / — firm request list (optional ?status=).
  router.get('/', requirePermission(deps, 'proposal:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.json({ requests: [] });
      return;
    }
    const status = req.query['status'] ? String(req.query['status']) : null;
    const where = status
      ? and(eq(signatureRequests.firmId, firmId), eq(signatureRequests.status, status))
      : eq(signatureRequests.firmId, firmId);
    const rows = await deps.db
      .select({
        id: signatureRequests.id,
        title: signatureRequests.title,
        status: signatureRequests.status,
        clientId: signatureRequests.clientId,
        formType: signatureRequests.formType,
        signerCount: signatureRequests.signerCount,
        signedCount: signatureRequests.signedCount,
        sentAt: signatureRequests.sentAt,
        completedAt: signatureRequests.completedAt,
        expiresAt: signatureRequests.expiresAt,
        createdAt: signatureRequests.createdAt,
      })
      .from(signatureRequests)
      .where(where)
      .orderBy(desc(signatureRequests.createdAt))
      .limit(500);
    res.json({ requests: rows });
  });

  // POST / — create a draft request + its signers.
  router.post(
    '/',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actor = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      const body = parsed.data;

      const created = await deps.db.transaction(async (tx) => {
        const [reqRow] = await tx
          .insert(signatureRequests)
          .values({
            firmId,
            clientId: body.clientId ?? null,
            title: body.title,
            formType: body.formType ?? null,
            sendInOrder: body.sendInOrder ?? false,
            pageGeometry: body.pageGeometry ?? null,
            signerCount: body.signers.length,
            createdBy: actor,
          })
          .returning({ id: signatureRequests.id });
        const requestId = reqRow!.id;
        await tx.insert(signatureSigners).values(
          body.signers.map((s, i) => ({
            requestId,
            name: s.name,
            email: s.email,
            role: s.role ?? null,
            order: s.order ?? i + 1,
          })),
        );
        await recordEvent(tx as unknown as Database, requestId, actor, 'created', {
          title: body.title,
          signerCount: body.signers.length,
        });
        return requestId;
      });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'signature_request',
        entityId: created,
        actorAppUserId: actor,
        after: { title: body.title, signerCount: body.signers.length, status: 'draft' },
      });
      res.status(201).json({ id: created });
    },
  );

  // GET /:id — full detail (request + signers + placements + events).
  router.get(
    '/:id',
    requirePermission(deps, 'proposal:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const request = await loadRequest(deps.db, firmId, req.params['id']!);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [signers, placements, events] = await Promise.all([
        deps.db
          .select()
          .from(signatureSigners)
          .where(eq(signatureSigners.requestId, request.id))
          .orderBy(signatureSigners.order),
        deps.db
          .select()
          .from(signatureFieldPlacements)
          .where(eq(signatureFieldPlacements.requestId, request.id)),
        deps.db
          .select()
          .from(signatureEvents)
          .where(eq(signatureEvents.requestId, request.id))
          .orderBy(desc(signatureEvents.createdAt))
          .limit(200),
      ]);
      res.json({ request, signers, placements, events });
    },
  );

  // PATCH /:id — edit draft-level fields (draft only).
  router.patch(
    '/:id',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actor = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      const request = await loadRequest(deps.db, firmId, req.params['id']!);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.status !== 'draft') {
        res.status(409).json({ error: 'not_editable', status: request.status });
        return;
      }
      const b = parsed.data;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.title !== undefined) patch['title'] = b.title;
      if (b.clientId !== undefined) patch['clientId'] = b.clientId;
      if (b.formType !== undefined) patch['formType'] = b.formType;
      if (b.sendInOrder !== undefined) patch['sendInOrder'] = b.sendInOrder;
      if (b.pageGeometry !== undefined) patch['pageGeometry'] = b.pageGeometry;
      await deps.db
        .update(signatureRequests)
        .set(patch)
        .where(eq(signatureRequests.id, request.id));
      await recordEvent(deps.db, request.id, actor, 'updated', { fields: Object.keys(b) });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'signature_request',
        entityId: request.id,
        actorAppUserId: actor,
        before: { title: request.title },
        after: b,
      });
      res.json({ ok: true });
    },
  );

  // POST /:id/signers — add a signer (draft only).
  router.post(
    '/:id/signers',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actor = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = SignerInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      const request = await loadRequest(deps.db, firmId, req.params['id']!);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.status !== 'draft') {
        res.status(409).json({ error: 'not_editable', status: request.status });
        return;
      }
      const s = parsed.data;
      const newId = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(signatureSigners)
          .values({
            requestId: request.id,
            name: s.name,
            email: s.email,
            role: s.role ?? null,
            order: s.order ?? request.signerCount + 1,
          })
          .returning({ id: signatureSigners.id });
        await tx
          .update(signatureRequests)
          .set({ signerCount: request.signerCount + 1, updatedAt: new Date() })
          .where(eq(signatureRequests.id, request.id));
        await recordEvent(tx as unknown as Database, request.id, actor, 'signer_added', {
          email: s.email,
        });
        return row!.id;
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'signature_request',
        entityId: request.id,
        actorAppUserId: actor,
        after: { addedSigner: s.email },
      });
      res.status(201).json({ id: newId });
    },
  );

  // DELETE /:id/signers/:signerId — remove a signer + its placements (draft).
  router.delete(
    '/:id/signers/:signerId',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actor = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const request = await loadRequest(deps.db, firmId, req.params['id']!);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.status !== 'draft') {
        res.status(409).json({ error: 'not_editable', status: request.status });
        return;
      }
      const signerId = req.params['signerId']!;
      const deleted = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .delete(signatureSigners)
          .where(and(eq(signatureSigners.id, signerId), eq(signatureSigners.requestId, request.id)))
          .returning({ id: signatureSigners.id });
        if (!row) return false;
        // FK cascade removes this signer's placements automatically.
        await tx
          .update(signatureRequests)
          .set({ signerCount: Math.max(0, request.signerCount - 1), updatedAt: new Date() })
          .where(eq(signatureRequests.id, request.id));
        await recordEvent(tx as unknown as Database, request.id, actor, 'signer_removed', {
          signerId,
        });
        return true;
      });
      if (!deleted) {
        res.status(404).json({ error: 'signer_not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'signature_request',
        entityId: request.id,
        actorAppUserId: actor,
        after: { removedSigner: signerId },
      });
      res.json({ ok: true });
    },
  );

  // PUT /:id/placements — replace the whole field set atomically (draft).
  // The editor saves the complete set; we validate then swap.
  router.put(
    '/:id/placements',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actor = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = PlacementsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      const request = await loadRequest(deps.db, firmId, req.params['id']!);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.status !== 'draft') {
        res.status(409).json({ error: 'not_editable', status: request.status });
        return;
      }
      const signers = await deps.db
        .select({ id: signatureSigners.id })
        .from(signatureSigners)
        .where(eq(signatureSigners.requestId, request.id));
      const geometry = (request.pageGeometry as PageGeometry[] | null) ?? null;
      const errors = validatePlacements(
        signers.map((s) => s.id),
        // reason: zod's enum widens fieldType to string; validation re-checks it.
        parsed.data.placements as unknown as PlacementInput[],
        geometry,
      );
      if (errors.length > 0) {
        res.status(422).json({ error: 'invalid_placements', errors });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx
          .delete(signatureFieldPlacements)
          .where(eq(signatureFieldPlacements.requestId, request.id));
        if (parsed.data.placements.length > 0) {
          await tx.insert(signatureFieldPlacements).values(
            parsed.data.placements.map((p) => ({
              requestId: request.id,
              signerId: p.signerId,
              fieldType: p.fieldType,
              pageNumber: p.pageNumber,
              nx: p.nx,
              ny: p.ny,
              nw: p.nw,
              nh: p.nh,
              required: p.required ?? true,
            })),
          );
        }
        await recordEvent(tx as unknown as Database, request.id, actor, 'placements_updated', {
          count: parsed.data.placements.length,
        });
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'signature_request',
        entityId: request.id,
        actorAppUserId: actor,
        after: { placements: parsed.data.placements.length },
      });
      res.json({ ok: true, count: parsed.data.placements.length });
    },
  );

  // DELETE /:id — discard a draft (sent requests must be voided via P6).
  router.delete(
    '/:id',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actor = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const request = await loadRequest(deps.db, firmId, req.params['id']!);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.status !== 'draft') {
        res.status(409).json({ error: 'not_deletable', status: request.status });
        return;
      }
      // Cascade removes signers / placements / events.
      await deps.db.delete(signatureRequests).where(eq(signatureRequests.id, request.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'signature_request',
        entityId: request.id,
        actorAppUserId: actor,
        before: { title: request.title, status: 'draft' },
      });
      res.json({ ok: true });
    },
  );

  return router;
}
