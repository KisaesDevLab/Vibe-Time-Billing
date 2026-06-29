// SPDX-License-Identifier: Elastic-2.0
//
// Admin → Printing. Firm pastes its Vibe Print gateway URL + bearer key
// and picks a default printer / auto-print toggle. Stored encrypted under
// KMS_KEY. "Test" lists printers from the gateway to validate URL + key.

import express, { type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings, offices, signaturePrintRules } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { listAssignments, upsertAssignment } from '../print-gateway/assignments';
import { listPrinters, listTemplates } from '../print-gateway/client';
import {
  encryptPrintGatewayConfig,
  loadPrintGatewayConfig,
  maskPrintGatewayConfig,
  resolvePrintGateway,
  type StoredPrintGatewayConfig,
} from '../print-gateway/config';

export interface PrintGatewayKeysRoutesDeps extends RbacDeps {
  db: Database | null;
}

const SaveSchema = z.object({
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  defaultPrinterId: z.number().int().positive().nullable().optional(),
  autoPrintSignatureConfirmation: z.boolean().optional(),
});

const TestSchema = z.object({
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().max(500).optional(),
});

export function createPrintGatewayKeysRouter(deps: PrintGatewayKeysRoutesDeps): Router {
  const router = express.Router();
  // Non-UUID :id (e.g. signature-print-rules/:id) → 404 instead of a
  // Postgres 22P02 → 500.
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'firm:settings:read'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ config: maskPrintGatewayConfig(null), kmsReady: Boolean(process.env['KMS_KEY']) });
      return;
    }
    const cfg = await loadPrintGatewayConfig(deps.db, firmId);
    res.json({ config: maskPrintGatewayConfig(cfg), kmsReady: Boolean(process.env['KMS_KEY']) });
  });

  router.put('/', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const parsed = SaveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ ok: true });
      return;
    }
    if (!process.env['KMS_KEY']) {
      res.status(503).json({ error: 'kms_unavailable' });
      return;
    }
    const current = (await loadPrintGatewayConfig(deps.db, firmId)) ?? {};
    const next: StoredPrintGatewayConfig = { ...current };
    const d = parsed.data;
    if (d.baseUrl !== undefined) {
      if (d.baseUrl === '') delete next.baseUrl;
      else next.baseUrl = d.baseUrl;
    }
    if (d.apiKey !== undefined) {
      if (d.apiKey === '') delete next.apiKey;
      else next.apiKey = d.apiKey;
    }
    if (d.enabled !== undefined) next.enabled = d.enabled;
    if (d.defaultPrinterId !== undefined) {
      if (d.defaultPrinterId === null) delete next.defaultPrinterId;
      else next.defaultPrinterId = d.defaultPrinterId;
    }
    if (d.autoPrintSignatureConfirmation !== undefined) {
      next.autoPrintSignatureConfirmation = d.autoPrintSignatureConfirmation;
    }
    await deps.db
      .update(firmSettings)
      .set({
        printGatewayConfigEncrypted: encryptPrintGatewayConfig(next),
        printGatewayConfigUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(firmSettings.firmId, firmId));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'print_gateway_config',
      entityId: firmId,
      actorAppUserId: req.staffSession!.appUserId,
      after: {
        baseUrlSet: Boolean(next.baseUrl),
        apiKeySet: Boolean(next.apiKey),
        enabled: Boolean(next.enabled),
        defaultPrinterId: next.defaultPrinterId ?? null,
        autoPrintSignatureConfirmation: Boolean(next.autoPrintSignatureConfirmation),
      },
    }).catch(() => undefined);
    res.json({ ok: true, config: maskPrintGatewayConfig(next) });
  });

  // Validate URL + key by listing the gateway's printers. Body values (if
  // present) take precedence over stored config, so the firm can test
  // before saving.
  router.post('/test', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const parsed = TestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const firmId = req.staffSession?.firmId;
    const stored = firmId && deps.db ? await loadPrintGatewayConfig(deps.db, firmId) : null;
    const baseUrl = (parsed.data.baseUrl || stored?.baseUrl || '').replace(/\/$/, '');
    const apiKey = parsed.data.apiKey || stored?.apiKey || '';
    if (!baseUrl || !apiKey) {
      res.status(400).json({ ok: false, error: 'missing_base_url_or_key' });
      return;
    }
    try {
      const printers = await listPrinters({
        baseUrl,
        apiKey,
        enabled: true,
        defaultPrinterId: null,
        autoPrintSignatureConfirmation: false,
      });
      res.json({ ok: true, printers });
    } catch (err) {
      res
        .status(422)
        .json({ ok: false, error: err instanceof Error ? err.message : 'test_failed' });
    }
  });

  // Printer → office assignments (for the per-location picker). Returns the
  // live gateway printer list, the offices, and the stored assignments so
  // the admin UI can render one row per printer.
  router.get('/assignments', requirePermission(deps, 'firm:settings:read'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ printers: [], offices: [], assignments: [] });
      return;
    }
    const gateway = await resolvePrintGateway(deps.db, firmId);
    let printers: Array<{ id: number; name: string }> = [];
    if (gateway) {
      try {
        printers = await listPrinters(gateway);
      } catch {
        /* gateway unreachable — UI still shows stored assignments */
      }
    }
    const [assignments, officeList] = await Promise.all([
      listAssignments(deps.db, firmId),
      deps.db
        .select({ id: offices.id, name: offices.name })
        .from(offices)
        .where(eq(offices.firmId, firmId)),
    ]);
    res.json({ printers, offices: officeList, assignments });
  });

  const AssignSchema = z.object({
    gatewayPrinterId: z.number().int().positive(),
    officeId: z.string().uuid().nullable().optional(),
    label: z.string().trim().max(120).nullable().optional(),
    enabled: z.boolean().optional(),
  });
  router.put('/assignments', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const parsed = AssignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ ok: true });
      return;
    }
    await upsertAssignment(deps.db, firmId, parsed.data);
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'printer_assignment',
      entityId: firmId,
      actorAppUserId: req.staffSession!.appUserId,
      after: {
        gatewayPrinterId: parsed.data.gatewayPrinterId,
        officeId: parsed.data.officeId ?? null,
      },
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  // ----- signature print rules (0187) -----

  // Gateway-side templates, for the rule editor's "Vibe Print template" picker.
  router.get(
    '/gateway-templates',
    requirePermission(deps, 'firm:settings:read'),
    async (req, res) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ templates: [] });
        return;
      }
      const gateway = await resolvePrintGateway(deps.db, firmId);
      if (!gateway) {
        res.json({ templates: [] });
        return;
      }
      try {
        res.json({ templates: await listTemplates(gateway) });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'gateway_unreachable' });
      }
    },
  );

  router.get(
    '/signature-print-rules',
    requirePermission(deps, 'firm:settings:read'),
    async (req, res) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ rules: [] });
        return;
      }
      const rules = await deps.db
        .select()
        .from(signaturePrintRules)
        .where(eq(signaturePrintRules.firmId, firmId))
        .orderBy(signaturePrintRules.priority);
      res.json({ rules });
    },
  );

  const RuleSchema = z.object({
    name: z.string().trim().min(1).max(120),
    priority: z.number().int().min(0).max(10000).optional(),
    enabled: z.boolean().optional(),
    formCodes: z.array(z.string().trim().max(40)).max(50).optional(),
    engagementTypeIds: z.array(z.string().uuid()).max(100).optional(),
    templateSource: z.enum(['builtin', 'gateway']),
    gatewayTemplateId: z.number().int().positive().nullable().optional(),
    printerMode: z.enum(['specific', 'client_office']),
    printerId: z.number().int().positive().nullable().optional(),
    copies: z.number().int().min(1).max(20).optional(),
  });

  router.post(
    '/signature-print-rules',
    requirePermission(deps, 'firm:settings:write'),
    async (req, res) => {
      const parsed = RuleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const d = parsed.data;
      const [row] = await deps.db
        .insert(signaturePrintRules)
        .values({
          firmId,
          name: d.name,
          priority: d.priority ?? 100,
          enabled: d.enabled ?? true,
          formCodes: d.formCodes ?? [],
          engagementTypeIds: d.engagementTypeIds ?? [],
          templateSource: d.templateSource,
          gatewayTemplateId: d.gatewayTemplateId ?? null,
          printerMode: d.printerMode,
          printerId: d.printerId ?? null,
          copies: d.copies ?? 1,
        })
        .returning({ id: signaturePrintRules.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'signature_print_rule',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { name: d.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.put(
    '/signature-print-rules/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req, res) => {
      const parsed = RuleSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const d = parsed.data;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of [
        'name',
        'priority',
        'enabled',
        'formCodes',
        'engagementTypeIds',
        'templateSource',
        'gatewayTemplateId',
        'printerMode',
        'printerId',
        'copies',
      ] as const) {
        if (d[k] !== undefined) updates[k] = d[k];
      }
      await deps.db
        .update(signaturePrintRules)
        .set(updates)
        .where(
          and(
            eq(signaturePrintRules.id, req.params['id']!),
            eq(signaturePrintRules.firmId, firmId),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.delete(
    '/signature-print-rules/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req, res) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .delete(signaturePrintRules)
        .where(
          and(
            eq(signaturePrintRules.id, req.params['id']!),
            eq(signaturePrintRules.firmId, firmId),
          ),
        );
      res.json({ ok: true });
    },
  );

  return router;
}
