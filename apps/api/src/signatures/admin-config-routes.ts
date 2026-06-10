// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin config for the bookmark-driven signing flow: per-return-type
// signature page rules (which bookmark names are signature pages) and the
// firm's default-document library (PDFs appended to a signing package, with
// optional saved field placements). Gated on firm:settings:{read,write}.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Readable } from 'node:stream';

import type { Database } from '@vibe/db';
import { signatureDocumentTemplates, signaturePageRules } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { capturePageGeometry } from './geometry';
import { seedDefaultSignaturePageRules } from './page-rules';

export interface SignatureConfigDeps extends RbacDeps {
  db: Database | null;
  storage?: StorageClient | null;
}

function resolveStorage(deps: SignatureConfigDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

const RuleSchema = z.object({
  formType: z.string().min(1).max(40),
  bookmarkPattern: z.string().min(1).max(200),
  matchMode: z.enum(['contains', 'exact', 'regex']).default('contains'),
  caseSensitive: z.boolean().default(false),
  layoutKey: z.enum(['us-8879', 'entity-8879', 'state-auth', 'generic']).default('generic'),
  enabled: z.boolean().default(true),
  notes: z.string().max(500).nullable().default(null),
  sortOrder: z.number().int().nonnegative().optional(),
});

const FieldSchema = z.object({
  role: z.string().min(1).max(40),
  fieldType: z.enum(['signature', 'initials', 'date', 'text', 'checkbox']),
  pageNumber: z.number().int().positive(),
  nx: z.number(),
  ny: z.number(),
  nw: z.number(),
  nh: z.number(),
  required: z.boolean().optional(),
});

export function createSignatureConfigRouter(deps: SignatureConfigDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['id']);

  // -------- Page rules --------
  router.get(
    '/page-rules',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ rules: [] });
        return;
      }
      // Auto-seed the defaults for a firm that has none yet.
      await seedDefaultSignaturePageRules(deps.db, firmId).catch(() => undefined);
      const rules = await deps.db
        .select()
        .from(signaturePageRules)
        .where(eq(signaturePageRules.firmId, firmId))
        .orderBy(asc(signaturePageRules.formType), asc(signaturePageRules.sortOrder));
      res.json({ rules });
    },
  );

  router.post(
    '/page-rules',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = RuleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid', detail: parsed.error.flatten() });
        return;
      }
      const [row] = await deps.db
        .insert(signaturePageRules)
        .values({ firmId, ...parsed.data, sortOrder: parsed.data.sortOrder ?? 0 })
        .returning();
      res.json({ rule: row });
    },
  );

  router.patch(
    '/page-rules/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = RuleSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid', detail: parsed.error.flatten() });
        return;
      }
      const [row] = await deps.db
        .update(signaturePageRules)
        .set(parsed.data)
        .where(
          and(eq(signaturePageRules.id, req.params['id']!), eq(signaturePageRules.firmId, firmId)),
        )
        .returning();
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ rule: row });
    },
  );

  router.delete(
    '/page-rules/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      await deps.db
        .delete(signaturePageRules)
        .where(
          and(eq(signaturePageRules.id, req.params['id']!), eq(signaturePageRules.firmId, firmId)),
        );
      res.json({ ok: true });
    },
  );

  // -------- Document templates --------
  router.get(
    '/doc-templates',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ templates: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: signatureDocumentTemplates.id,
          formType: signatureDocumentTemplates.formType,
          name: signatureDocumentTemplates.name,
          totalPages: signatureDocumentTemplates.totalPages,
          fields: signatureDocumentTemplates.fields,
          autoInclude: signatureDocumentTemplates.autoInclude,
          enabled: signatureDocumentTemplates.enabled,
          sortOrder: signatureDocumentTemplates.sortOrder,
          createdAt: signatureDocumentTemplates.createdAt,
        })
        .from(signatureDocumentTemplates)
        .where(eq(signatureDocumentTemplates.firmId, firmId))
        .orderBy(
          asc(signatureDocumentTemplates.formType),
          asc(signatureDocumentTemplates.sortOrder),
        );
      res.json({ templates: rows });
    },
  );

  // Upload a new default document (raw application/pdf; name + formType in the
  // query string). Stores the PDF, captures geometry, inserts the row.
  router.post(
    '/doc-templates',
    requirePermission(deps, 'firm:settings:write'),
    express.raw({ type: 'application/pdf', limit: 25 * 1024 * 1024 }),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const storage = resolveStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const name = String(req.query['name'] ?? '').trim();
      const formType = String(req.query['formType'] ?? '').trim();
      const body = req.body as Buffer;
      if (!name || !formType || !Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'name_formType_and_pdf_required' });
        return;
      }
      let geometry;
      try {
        geometry = await capturePageGeometry(body);
      } catch {
        res.status(400).json({ error: 'invalid_pdf' });
        return;
      }
      const [row] = await deps.db
        .insert(signatureDocumentTemplates)
        .values({
          firmId,
          formType,
          name,
          storageKey: '',
          totalPages: geometry.length,
          pageGeometry: geometry,
        })
        .returning({ id: signatureDocumentTemplates.id });
      const key = `signature-templates/${firmId}/${row!.id}.pdf`;
      await storage.put(key, body, { contentType: 'application/pdf' });
      await deps.db
        .update(signatureDocumentTemplates)
        .set({ storageKey: key })
        .where(eq(signatureDocumentTemplates.id, row!.id));
      res.json({ id: row!.id });
    },
  );

  // Preview the template PDF (inline).
  router.get(
    '/doc-templates/:id/source',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const storage = resolveStorage(deps);
      const [row] = await deps.db
        .select({ storageKey: signatureDocumentTemplates.storageKey })
        .from(signatureDocumentTemplates)
        .where(
          and(
            eq(signatureDocumentTemplates.id, req.params['id']!),
            eq(signatureDocumentTemplates.firmId, firmId),
          ),
        )
        .limit(1);
      if (!row?.storageKey || !storage) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const obj = await storage.get(row.storageKey);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="template.pdf"');
      res.setHeader('Cache-Control', 'private, no-store');
      (obj.body as Readable).pipe(res);
    },
  );

  // Save the role-tagged field placements for a template.
  router.put(
    '/doc-templates/:id/fields',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = z.object({ fields: z.array(FieldSchema) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid', detail: parsed.error.flatten() });
        return;
      }
      const [row] = await deps.db
        .update(signatureDocumentTemplates)
        .set({ fields: parsed.data.fields })
        .where(
          and(
            eq(signatureDocumentTemplates.id, req.params['id']!),
            eq(signatureDocumentTemplates.firmId, firmId),
          ),
        )
        .returning({ id: signatureDocumentTemplates.id });
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.patch(
    '/doc-templates/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = z
        .object({
          name: z.string().min(1).max(200).optional(),
          formType: z.string().min(1).max(40).optional(),
          autoInclude: z.boolean().optional(),
          enabled: z.boolean().optional(),
          sortOrder: z.number().int().nonnegative().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid', detail: parsed.error.flatten() });
        return;
      }
      const [row] = await deps.db
        .update(signatureDocumentTemplates)
        .set(parsed.data)
        .where(
          and(
            eq(signatureDocumentTemplates.id, req.params['id']!),
            eq(signatureDocumentTemplates.firmId, firmId),
          ),
        )
        .returning({ id: signatureDocumentTemplates.id });
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.delete(
    '/doc-templates/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      await deps.db
        .delete(signatureDocumentTemplates)
        .where(
          and(
            eq(signatureDocumentTemplates.id, req.params['id']!),
            eq(signatureDocumentTemplates.firmId, firmId),
          ),
        );
      res.json({ ok: true });
    },
  );

  return router;
}
