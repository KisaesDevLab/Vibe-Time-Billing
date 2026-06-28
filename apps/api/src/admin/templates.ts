// SPDX-License-Identifier: Elastic-2.0
//
// Template CRUD endpoints (v2 Sprint D). Three template types share the
// same shape: list, get, create, clone, patch, archive. A small factory
// loop registers all three under /admin/templates/<kind>.
//
//   engagement   — engagement_template (fee structure + work codes)
//   letter       — engagement_letter_template (bodyHtml + variables)
//   client       — client_template (wizard prefills)

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import QRCode from 'qrcode';

import type { Database } from '@vibe/db';
import {
  clientTemplates,
  engagementLetterTemplates,
  engagementTemplates,
  invoiceTemplates,
  statementTemplates,
} from '@vibe/db/schema';
import {
  buildInvoiceTemplateContext,
  buildStatementTemplateContext,
  composeInvoiceHtml,
  DEFAULT_INVOICE_BODY_HTML,
  DEFAULT_INVOICE_CSS,
  DEFAULT_INVOICE_TEMPLATE_VERSION,
  DEFAULT_STATEMENT_BODY_HTML,
  DEFAULT_STATEMENT_CSS,
  DEFAULT_STATEMENT_TEMPLATE_VERSION,
  INVOICE_TEMPLATE_TOKENS,
  STATEMENT_TEMPLATE_TOKENS,
  type InvoiceTemplateInput,
  type StatementTemplateInput,
} from '@vibe/core/invoicing';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { loadRandomInvoiceInput } from '../invoices/sample-render-input';
import { loadRandomStatementInput } from '../statements/sample-render-input';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface TemplateRoutesDeps extends RbacDeps {
  db: Database | null;
}

const FEE_STRUCTURES = [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_WITH_MILESTONES',
  'RECURRING_SUBSCRIPTION',
] as const;

const EngagementSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(200),
  engagementTypeId: z.string().uuid().nullable().optional(),
  defaultFeeStructure: z.enum(FEE_STRUCTURES),
  defaultFeeAmountCents: z.number().int().nonnegative().nullable().optional(),
  defaultBudgetHours: z.number().nonnegative().nullable().optional(),
  inScopeWorkCodeIds: z.array(z.string().uuid()).optional(),
  defaultLetterTemplateId: z.string().uuid().nullable().optional(),
  // 0054 — engagements created from this template inherit this code.
  defaultRateCodeId: z.string().uuid().nullable().optional(),
  customFieldsSchema: z.record(z.string(), z.unknown()).optional(),
  // 0083 — optional Mustache-style template resolved at
  // engagement-creation time. Supports {{client.name}},
  // {{period.year/month/label}}, {{today}}, {{engagement.*}}. NULL =
  // use static `name` field as the engagement name.
  namePattern: z.string().max(200).nullable().optional(),
  // 0170 — defaults for the create form's green toggles + sub-config.
  defaultMixedModeEnabled: z.boolean().optional(),
  defaultFeePassthroughEnabled: z.boolean().optional(),
  defaultTaxEnabled: z.boolean().optional(),
  defaultTaxRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  defaultTaxLabel: z.string().min(1).max(80).nullable().optional(),
  defaultSurchargeEnabled: z.boolean().optional(),
  defaultSurchargeType: z.enum(['PERCENT', 'FLAT_AMOUNT']).nullable().optional(),
  defaultSurchargeValueBps: z.number().int().min(0).max(10_000).nullable().optional(),
  defaultSurchargeAmountCents: z.number().int().nonnegative().nullable().optional(),
  defaultSurchargeLabel: z.string().min(1).max(80).nullable().optional(),
  defaultRecurrenceFrequency: z
    .enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'])
    .nullable()
    .optional(),
  defaultRecurrenceTriggerMode: z.enum(['SCHEDULE', 'ON_COMPLETION']).nullable().optional(),
  // 0172 — lifecycle status applied to engagements spawned by a recurrence
  // built from this template.
  defaultRecurrenceStatus: z
    .enum(['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'])
    .nullable()
    .optional(),
});

const LetterSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(200),
  engagementTypeId: z.string().uuid().nullable().optional(),
  bodyHtml: z.string().min(1),
});

const ClientTemplateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(200),
  clientType: z.enum(['INDIVIDUAL', 'BUSINESS']),
  defaultsJson: z.record(z.string(), z.unknown()).optional(),
  defaultEngagementTemplateIds: z.array(z.string().uuid()).optional(),
});

const InvoiceTemplateSchema = z.object({
  bodyHtml: z.string().max(200_000).nullable().optional(),
  css: z.string().max(100_000).nullable().optional(),
  builtinStyle: z.enum(['modern', 'classic', 'minimal']).nullable().optional(),
});

// Representative invoice used to render the editor's live preview. Keeps
// the preview deterministic and dependency-free (no DB read).
const SAMPLE_INVOICE: InvoiceTemplateInput = {
  invoiceNumber: 'INV-2025-0042',
  issueDate: '2025-12-10',
  dueDate: '2025-12-10',
  firm: {
    name: 'Northwind Tax & Advisory, PC',
    logoUrl: null,
    address:
      '100 Commerce Plaza, Suite 200\nSpringfield, IL 62704\n(555) 555-0100  •  www.example.com',
  },
  branding: {
    accentColor: '#1a1a1a',
    supportEmail: 'billing@example.com',
    supportPhone: '(555) 555-0100',
    supportFax: null,
    supportWeb: 'www.example.com',
    footerHtml:
      "<strong>PLEASE MAIL PAYMENTS TO:</strong> Northwind Tax & Advisory, PC, PO Box 100, Springfield, IL 62704<br>EIN: 00-0000000<br><span class='terms'>Payment is due upon presentation of this invoice.</span>",
  },
  client: {
    name: 'Riverside Bakery & Co., LLC',
    externalId: 'RIVB1042',
    mailingStreet1: '128 Birchwood Lane',
    mailingCity: 'Springfield',
    mailingState: 'IL',
    mailingPostal: '62704',
  },
  lines: [
    {
      kind: 'TIME_AGGREGATE',
      description: 'For services provided in compilation of financial statements as of 11/30/2025',
      amountCents: 35000,
    },
    { kind: 'SURCHARGE', description: 'Technology Surcharge', amountCents: 1400 },
    { kind: 'SALES_TAX', description: 'Sales Tax', amountCents: 2871 },
  ],
  subtotalCents: 35000,
  surchargeCents: 1400,
  taxCents: 2871,
  processingFeeCents: 0,
  totalCents: 39271,
  notes: 'Thank you for your business.',
  paidCents: 0,
  status: 'SENT',
};

const StatementTemplateSchema = z.object({
  bodyHtml: z.string().max(200_000).nullable().optional(),
  css: z.string().max(100_000).nullable().optional(),
  builtinStyle: z.enum(['classic']).nullable().optional(),
});

// Representative statement used for the editor preview when the firm has
// no invoices yet (otherwise a random real client's statement is used).
const SAMPLE_STATEMENT: StatementTemplateInput = {
  statementDate: '2025-12-31',
  firm: {
    name: 'Northwind Tax & Advisory, PC',
    logoUrl: null,
    address: '100 Commerce Plaza, Suite 200\nSpringfield, IL 62704',
  },
  branding: {
    accentColor: '#1a1a1a',
    supportEmail: 'billing@example.com',
    supportPhone: '(555) 555-0100',
    supportFax: null,
    supportWeb: 'www.example.com',
    footerHtml:
      "<span class='terms'>Please remit payment to Northwind Tax & Advisory, PC, PO Box 100, Springfield, IL 62704.</span>",
  },
  client: {
    name: 'Riverside Bakery & Co., LLC',
    externalId: 'RIVB1042',
    mailingStreet1: '128 Birchwood Lane',
    mailingCity: 'Springfield',
    mailingState: 'IL',
    mailingPostal: '62704',
  },
  lines: [
    {
      date: '2025-11-10',
      type: 'Invoice',
      reference: 'INV-2025-0031',
      debitCents: 35000,
      balanceCents: 35000,
    },
    {
      date: '2025-11-28',
      type: 'Payment',
      reference: 'a1b2c3d4',
      creditCents: 20000,
      balanceCents: 15000,
    },
    {
      date: '2025-12-12',
      type: 'Invoice',
      reference: 'INV-2025-0042',
      debitCents: 39271,
      balanceCents: 54271,
    },
  ],
  totalAmountDueCents: 54271,
  aging: { d_0_30: 39271, d_31_60: 15000, d_61_90: 0, d_91_120: 0, d_121_plus: 0 },
  policyNotice:
    'Accounts with balances over 90 days past due will have all work suspended until payment is received.',
};

// Mine {{placeholder}} markers from a body for the variable picker.
function extractVariables(text: string): string[] {
  const re = /{{\s*([a-zA-Z0-9_.]+)\s*}}/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) seen.add(m[1]!);
  return Array.from(seen).sort();
}

export function createTemplateRouter(deps: TemplateRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ----- Engagement templates -----
  router.get(
    '/engagement',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(engagementTemplates)
        .where(eq(engagementTemplates.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/engagement',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const d = parsed.data;
      const [row] = await deps.db
        .insert(engagementTemplates)
        .values({
          firmId,
          key: d.key,
          name: d.name,
          engagementTypeId: d.engagementTypeId ?? null,
          defaultFeeStructure: d.defaultFeeStructure,
          defaultFeeAmountCents: d.defaultFeeAmountCents ?? null,
          defaultBudgetHours: d.defaultBudgetHours != null ? String(d.defaultBudgetHours) : null,
          inScopeWorkCodeIds: d.inScopeWorkCodeIds ?? [],
          defaultLetterTemplateId: d.defaultLetterTemplateId ?? null,
          defaultRateCodeId: d.defaultRateCodeId ?? null,
          customFieldsSchema: d.customFieldsSchema ?? {},
          namePattern: d.namePattern ?? null,
          defaultMixedModeEnabled: d.defaultMixedModeEnabled ?? false,
          defaultFeePassthroughEnabled: d.defaultFeePassthroughEnabled ?? false,
          defaultTaxEnabled: d.defaultTaxEnabled ?? false,
          defaultTaxRateBps: d.defaultTaxRateBps ?? null,
          defaultTaxLabel: d.defaultTaxLabel ?? null,
          defaultSurchargeEnabled: d.defaultSurchargeEnabled ?? false,
          defaultSurchargeType: d.defaultSurchargeType ?? null,
          defaultSurchargeValueBps: d.defaultSurchargeValueBps ?? null,
          defaultSurchargeAmountCents: d.defaultSurchargeAmountCents ?? null,
          defaultSurchargeLabel: d.defaultSurchargeLabel ?? null,
          defaultRecurrenceFrequency: d.defaultRecurrenceFrequency ?? null,
          defaultRecurrenceTriggerMode: d.defaultRecurrenceTriggerMode ?? null,
          defaultRecurrenceStatus: d.defaultRecurrenceStatus ?? null,
          isSystem: false,
        })
        .returning({ id: engagementTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { key: d.key, name: d.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/engagement/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const d = parsed.data;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (d.key !== undefined) updates.key = d.key;
      if (d.name !== undefined) updates.name = d.name;
      if (d.engagementTypeId !== undefined) updates.engagementTypeId = d.engagementTypeId;
      if (d.defaultFeeStructure !== undefined) updates.defaultFeeStructure = d.defaultFeeStructure;
      if (d.defaultFeeAmountCents !== undefined)
        updates.defaultFeeAmountCents = d.defaultFeeAmountCents;
      if (d.defaultBudgetHours !== undefined)
        updates.defaultBudgetHours =
          d.defaultBudgetHours != null ? String(d.defaultBudgetHours) : null;
      if (d.inScopeWorkCodeIds !== undefined) updates.inScopeWorkCodeIds = d.inScopeWorkCodeIds;
      if (d.defaultLetterTemplateId !== undefined)
        updates.defaultLetterTemplateId = d.defaultLetterTemplateId;
      if (d.defaultRateCodeId !== undefined) updates.defaultRateCodeId = d.defaultRateCodeId;
      if (d.customFieldsSchema !== undefined) updates.customFieldsSchema = d.customFieldsSchema;
      if (d.namePattern !== undefined) updates.namePattern = d.namePattern;
      if (d.defaultMixedModeEnabled !== undefined)
        updates.defaultMixedModeEnabled = d.defaultMixedModeEnabled;
      if (d.defaultFeePassthroughEnabled !== undefined)
        updates.defaultFeePassthroughEnabled = d.defaultFeePassthroughEnabled;
      if (d.defaultTaxEnabled !== undefined) updates.defaultTaxEnabled = d.defaultTaxEnabled;
      if (d.defaultTaxRateBps !== undefined) updates.defaultTaxRateBps = d.defaultTaxRateBps;
      if (d.defaultTaxLabel !== undefined) updates.defaultTaxLabel = d.defaultTaxLabel;
      if (d.defaultSurchargeEnabled !== undefined)
        updates.defaultSurchargeEnabled = d.defaultSurchargeEnabled;
      if (d.defaultSurchargeType !== undefined)
        updates.defaultSurchargeType = d.defaultSurchargeType;
      if (d.defaultSurchargeValueBps !== undefined)
        updates.defaultSurchargeValueBps = d.defaultSurchargeValueBps;
      if (d.defaultSurchargeAmountCents !== undefined)
        updates.defaultSurchargeAmountCents = d.defaultSurchargeAmountCents;
      if (d.defaultSurchargeLabel !== undefined)
        updates.defaultSurchargeLabel = d.defaultSurchargeLabel;
      if (d.defaultRecurrenceFrequency !== undefined)
        updates.defaultRecurrenceFrequency = d.defaultRecurrenceFrequency;
      if (d.defaultRecurrenceTriggerMode !== undefined)
        updates.defaultRecurrenceTriggerMode = d.defaultRecurrenceTriggerMode;
      if (d.defaultRecurrenceStatus !== undefined)
        updates.defaultRecurrenceStatus = d.defaultRecurrenceStatus;
      await deps.db
        .update(engagementTemplates)
        .set(updates)
        .where(
          and(
            eq(engagementTemplates.id, req.params['id']!),
            eq(engagementTemplates.firmId, firmId),
          ),
        );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.patch(
    '/engagement/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(engagementTemplates)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(
          and(
            eq(engagementTemplates.id, req.params['id']!),
            eq(engagementTemplates.firmId, firmId),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.post(
    '/engagement/:id/clone',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [src] = await deps.db
        .select()
        .from(engagementTemplates)
        .where(
          and(
            eq(engagementTemplates.id, req.params['id']!),
            eq(engagementTemplates.firmId, firmId),
          ),
        )
        .limit(1);
      if (!src) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const cloneKey = `${src.key}_copy_${Date.now().toString(36)}`;
      const [row] = await deps.db
        .insert(engagementTemplates)
        .values({
          firmId,
          key: cloneKey,
          name: `${src.name} (copy)`,
          engagementTypeId: src.engagementTypeId,
          defaultFeeStructure: src.defaultFeeStructure,
          defaultFeeAmountCents: src.defaultFeeAmountCents,
          defaultBudgetHours: src.defaultBudgetHours,
          inScopeWorkCodeIds: src.inScopeWorkCodeIds,
          defaultLetterTemplateId: src.defaultLetterTemplateId,
          defaultRateCodeId: src.defaultRateCodeId,
          customFieldsSchema: src.customFieldsSchema,
          namePattern: src.namePattern,
          defaultMixedModeEnabled: src.defaultMixedModeEnabled,
          defaultFeePassthroughEnabled: src.defaultFeePassthroughEnabled,
          defaultTaxEnabled: src.defaultTaxEnabled,
          defaultTaxRateBps: src.defaultTaxRateBps,
          defaultTaxLabel: src.defaultTaxLabel,
          defaultSurchargeEnabled: src.defaultSurchargeEnabled,
          defaultSurchargeType: src.defaultSurchargeType,
          defaultSurchargeValueBps: src.defaultSurchargeValueBps,
          defaultSurchargeAmountCents: src.defaultSurchargeAmountCents,
          defaultSurchargeLabel: src.defaultSurchargeLabel,
          defaultRecurrenceFrequency: src.defaultRecurrenceFrequency,
          defaultRecurrenceTriggerMode: src.defaultRecurrenceTriggerMode,
          defaultRecurrenceStatus: src.defaultRecurrenceStatus,
          isSystem: false,
        })
        .returning({ id: engagementTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { clonedFrom: src.id, key: cloneKey },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  // ----- Letter templates -----
  router.get(
    '/letter',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(engagementLetterTemplates)
        .where(eq(engagementLetterTemplates.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/letter',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = LetterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const d = parsed.data;
      const [row] = await deps.db
        .insert(engagementLetterTemplates)
        .values({
          firmId,
          key: d.key,
          name: d.name,
          engagementTypeId: d.engagementTypeId ?? null,
          bodyHtml: d.bodyHtml,
          variablesJson: extractVariables(d.bodyHtml),
          isSystem: false,
        })
        .returning({ id: engagementLetterTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_letter_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { key: d.key, name: d.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/letter/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = LetterSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const d = parsed.data;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (d.key !== undefined) updates.key = d.key;
      if (d.name !== undefined) updates.name = d.name;
      if (d.engagementTypeId !== undefined) updates.engagementTypeId = d.engagementTypeId;
      if (d.bodyHtml !== undefined) {
        updates.bodyHtml = d.bodyHtml;
        updates.variablesJson = extractVariables(d.bodyHtml);
      }
      await deps.db
        .update(engagementLetterTemplates)
        .set(updates)
        .where(
          and(
            eq(engagementLetterTemplates.id, req.params['id']!),
            eq(engagementLetterTemplates.firmId, firmId),
          ),
        );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_letter_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.patch(
    '/letter/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(engagementLetterTemplates)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(
          and(
            eq(engagementLetterTemplates.id, req.params['id']!),
            eq(engagementLetterTemplates.firmId, firmId),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_letter_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ----- Client templates -----
  router.get(
    '/client',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientTemplates)
        .where(eq(clientTemplates.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/client',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = ClientTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const d = parsed.data;
      const [row] = await deps.db
        .insert(clientTemplates)
        .values({
          firmId,
          key: d.key,
          name: d.name,
          clientType: d.clientType,
          defaultsJson: d.defaultsJson ?? {},
          defaultEngagementTemplateIds: d.defaultEngagementTemplateIds ?? [],
          isSystem: false,
        })
        .returning({ id: clientTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { key: d.key, name: d.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/client/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = ClientTemplateSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const d = parsed.data;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (d.key !== undefined) updates.key = d.key;
      if (d.name !== undefined) updates.name = d.name;
      if (d.clientType !== undefined) updates.clientType = d.clientType;
      if (d.defaultsJson !== undefined) updates.defaultsJson = d.defaultsJson;
      if (d.defaultEngagementTemplateIds !== undefined)
        updates.defaultEngagementTemplateIds = d.defaultEngagementTemplateIds;
      await deps.db
        .update(clientTemplates)
        .set(updates)
        .where(and(eq(clientTemplates.id, req.params['id']!), eq(clientTemplates.firmId, firmId)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.patch(
    '/client/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(clientTemplates)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(and(eq(clientTemplates.id, req.params['id']!), eq(clientTemplates.firmId, firmId)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ----- Invoice document template (single, firm-wide) -----

  // The catalog of tokens the editor's variable picker offers, plus the
  // shipped default body/css (so the editor can "reset to default").
  router.get('/invoice/variables', requirePermission(deps, 'taxonomy:read'), (_req, res) => {
    res.json({
      tokens: INVOICE_TEMPLATE_TOKENS,
      defaults: {
        bodyHtml: DEFAULT_INVOICE_BODY_HTML,
        css: DEFAULT_INVOICE_CSS,
        version: DEFAULT_INVOICE_TEMPLATE_VERSION,
      },
      builtinStyles: ['modern', 'classic', 'minimal'],
    });
  });

  router.get('/invoice', requirePermission(deps, 'taxonomy:read'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({
        template: {
          bodyHtml: DEFAULT_INVOICE_BODY_HTML,
          css: DEFAULT_INVOICE_CSS,
          builtinStyle: null,
        },
        isDefault: true,
      });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(invoiceTemplates)
      .where(eq(invoiceTemplates.firmId, firmId))
      .limit(1);
    if (!row) {
      res.json({
        template: {
          bodyHtml: DEFAULT_INVOICE_BODY_HTML,
          css: DEFAULT_INVOICE_CSS,
          builtinStyle: null,
        },
        isDefault: true,
      });
      return;
    }
    res.json({ template: row, isDefault: false });
  });

  router.put('/invoice', requirePermission(deps, 'taxonomy:write'), async (req, res) => {
    const parsed = InvoiceTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const d = parsed.data;
    const bodyHtml = d.bodyHtml ?? DEFAULT_INVOICE_BODY_HTML;
    const css = d.css ?? DEFAULT_INVOICE_CSS;
    const builtinStyle = d.builtinStyle ?? null;
    await deps.db
      .insert(invoiceTemplates)
      .values({
        firmId,
        bodyHtml,
        css,
        builtinStyle,
        variablesJson: extractVariables(bodyHtml),
        updatedByAppUserId: req.staffSession!.appUserId,
      })
      .onConflictDoUpdate({
        target: invoiceTemplates.firmId,
        set: {
          bodyHtml,
          css,
          builtinStyle,
          variablesJson: extractVariables(bodyHtml),
          updatedByAppUserId: req.staffSession!.appUserId,
          updatedAt: new Date(),
        },
      });
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'invoice_template',
      entityId: firmId,
      actorAppUserId: req.staffSession!.appUserId,
      after: { builtinStyle, variables: extractVariables(bodyHtml) },
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  // Render the (possibly unsaved) body+css against sample data for the
  // live preview. No DB write. `?format=pdf` returns the actual
  // Puppeteer-rendered PDF (true WYSIWYG, print media); otherwise HTML.
  router.post('/invoice/preview', requirePermission(deps, 'taxonomy:read'), async (req, res) => {
    const parsed = InvoiceTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const bodyHtml = parsed.data.bodyHtml ?? DEFAULT_INVOICE_BODY_HTML;
    const css = parsed.data.css ?? DEFAULT_INVOICE_CSS;
    // Preview against a RANDOM real invoice so the editor reflects the
    // firm's actual data/branding; fall back to the built-in sample only
    // when the firm has no invoices yet.
    const firmId = req.staffSession?.firmId;
    let sample = SAMPLE_INVOICE;
    if (firmId && deps.db) {
      try {
        const real = await loadRandomInvoiceInput(deps.db, firmId);
        if (real) sample = real;
      } catch (err) {
        logger.warn({ err }, 'invoice preview: random invoice load failed; using sample');
      }
    }
    // Placeholder pay QR so the editor preview shows the layout.
    let payUrl: string | undefined;
    let payQrDataUri: string | undefined;
    try {
      payUrl = 'https://example.com/pay/SAMPLE-TOKEN';
      payQrDataUri = await QRCode.toDataURL(payUrl, { margin: 1, width: 240 });
    } catch {
      /* preview QR is best-effort */
    }
    const ctx = buildInvoiceTemplateContext(sample, {
      dunning:
        'Your account is past due. A 1.5% monthly interest charge applies to balances over 30 days.',
      payUrl,
      payQrDataUri,
    });
    const html = composeInvoiceHtml(bodyHtml, css, ctx);
    if (req.query['format'] === 'pdf') {
      try {
        const { renderHtmlToPdf } = await import('../pdf/render');
        const pdf = await renderHtmlToPdf(html);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="invoice-preview.pdf"');
        res.send(pdf);
      } catch (err) {
        logger.error({ err }, 'invoice template preview pdf render failed');
        res.status(500).json({ error: 'pdf_render_failed' });
      }
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  // ----- Statement document template (single, firm-wide) -----

  router.get('/statement/variables', requirePermission(deps, 'taxonomy:read'), (_req, res) => {
    res.json({
      tokens: STATEMENT_TEMPLATE_TOKENS,
      defaults: {
        bodyHtml: DEFAULT_STATEMENT_BODY_HTML,
        css: DEFAULT_STATEMENT_CSS,
        version: DEFAULT_STATEMENT_TEMPLATE_VERSION,
      },
      builtinStyles: ['classic'],
    });
  });

  router.get('/statement', requirePermission(deps, 'taxonomy:read'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({
        template: {
          bodyHtml: DEFAULT_STATEMENT_BODY_HTML,
          css: DEFAULT_STATEMENT_CSS,
          builtinStyle: null,
        },
        isDefault: true,
      });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(statementTemplates)
      .where(eq(statementTemplates.firmId, firmId))
      .limit(1);
    if (!row) {
      res.json({
        template: {
          bodyHtml: DEFAULT_STATEMENT_BODY_HTML,
          css: DEFAULT_STATEMENT_CSS,
          builtinStyle: null,
        },
        isDefault: true,
      });
      return;
    }
    res.json({ template: row, isDefault: false });
  });

  router.put('/statement', requirePermission(deps, 'taxonomy:write'), async (req, res) => {
    const parsed = StatementTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const d = parsed.data;
    const bodyHtml = d.bodyHtml ?? DEFAULT_STATEMENT_BODY_HTML;
    const css = d.css ?? DEFAULT_STATEMENT_CSS;
    const builtinStyle = d.builtinStyle ?? null;
    await deps.db
      .insert(statementTemplates)
      .values({
        firmId,
        bodyHtml,
        css,
        builtinStyle,
        variablesJson: extractVariables(bodyHtml),
        updatedByAppUserId: req.staffSession!.appUserId,
      })
      .onConflictDoUpdate({
        target: statementTemplates.firmId,
        set: {
          bodyHtml,
          css,
          builtinStyle,
          variablesJson: extractVariables(bodyHtml),
          updatedByAppUserId: req.staffSession!.appUserId,
          updatedAt: new Date(),
        },
      });
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'statement_template',
      entityId: firmId,
      actorAppUserId: req.staffSession!.appUserId,
      after: { builtinStyle, variables: extractVariables(bodyHtml) },
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  router.post('/statement/preview', requirePermission(deps, 'taxonomy:read'), async (req, res) => {
    const parsed = StatementTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const bodyHtml = parsed.data.bodyHtml ?? DEFAULT_STATEMENT_BODY_HTML;
    const css = parsed.data.css ?? DEFAULT_STATEMENT_CSS;
    const firmId = req.staffSession?.firmId;
    let sample = SAMPLE_STATEMENT;
    if (firmId && deps.db) {
      try {
        const real = await loadRandomStatementInput(deps.db, firmId);
        if (real && real.lines.length > 0) sample = real;
      } catch (err) {
        logger.warn({ err }, 'statement preview: random statement load failed; using sample');
      }
    }
    const html = composeInvoiceHtml(bodyHtml, css, buildStatementTemplateContext(sample));
    if (req.query['format'] === 'pdf') {
      try {
        const { renderHtmlToPdf } = await import('../pdf/render');
        const pdf = await renderHtmlToPdf(html);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="statement-preview.pdf"');
        res.send(pdf);
      } catch (err) {
        logger.error({ err }, 'statement template preview pdf render failed');
        res.status(500).json({ error: 'pdf_render_failed' });
      }
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  return router;
}
