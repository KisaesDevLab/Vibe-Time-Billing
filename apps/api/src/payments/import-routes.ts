// SPDX-License-Identifier: Elastic-2.0
//
// Payments → Import tab. Ingests a payroll-charges CSV (client code,
// client name, charge date, description, amount):
//
//   POST /preview — parse + match (client by external_id→aws_id, ACTIVE
//          engagement of the chosen type, unbilled WIP, duplicate probe).
//          Read-only; returns per-client groups with a planned outcome.
//   POST /        — create an import header (also idempotently seeds the
//          firm's payment-method catalog with the chosen key).
//   POST /:id/rows — record row outcomes after the UI commits a group
//          via the existing billing-batch / adjustment / invoice /
//          receive endpoints.
//   GET  /        — import history (for the tab's past-imports list).
//   GET  /:id     — one import with its rows.
//
// The commit itself deliberately reuses the existing, battle-tested
// endpoints (billing-batches → adjustments → finalize →
// invoices/generate-from-batch → payments/receive) orchestrated by the
// web client, exactly like the manual pre-bill flow. This file only
// adds matching + audit.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  clients,
  engagements,
  engagementTypes,
  paymentImportRows,
  paymentImports,
  paymentMethodTypes,
  reasonCodes,
  timeEntries,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { parseCsv } from '../clients/import';

export interface PaymentImportRoutesDeps extends RbacDeps {
  db: Database | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- CSV shape --------------------------------------------------------

interface ParsedLine {
  line: number; // 1-based CSV line (header = 1)
  clientCode: string;
  clientName: string;
  chargeDate: string; // YYYY-MM-DD
  description: string;
  amountCents: number;
}

const HEADER_ALIASES: Record<string, string> = {
  client_code: 'client_code',
  code: 'client_code',
  client_name: 'client_name',
  name: 'client_name',
  charge_date: 'charge_date',
  date: 'charge_date',
  description: 'description',
  memo: 'description',
  amount: 'amount',
  amount_paid: 'amount',
};

function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/** "06/12/2026" or "2026-06-12" → "2026-06-12" (null when unparseable). */
function parseDate(raw: string): string | null {
  const t = raw.trim();
  if (DATE_RE.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

/** "82.6500" / "1,234.56" / "$56" → cents (null when unparseable). */
function parseAmountCents(raw: string): number | null {
  const t = raw.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

function parseLines(csv: string): {
  lines: ParsedLine[];
  errors: { line: number; error: string }[];
} {
  const { header, rows } = parseCsv(csv);
  const cols = header.map((h) => HEADER_ALIASES[normalizeHeader(h)] ?? null);
  const idx = (name: string): number => cols.indexOf(name);
  const errors: { line: number; error: string }[] = [];
  if (idx('client_code') < 0 || idx('charge_date') < 0 || idx('amount') < 0) {
    return {
      lines: [],
      errors: [{ line: 1, error: 'missing_required_columns (client code, charge date, amount)' }],
    };
  }
  const lines: ParsedLine[] = [];
  rows.forEach((r, i) => {
    const lineNo = i + 2;
    const code = (r[idx('client_code')] ?? '').trim();
    if (!code) return; // blank line
    const date = parseDate(r[idx('charge_date')] ?? '');
    const amountCents = parseAmountCents(r[idx('amount')] ?? '');
    if (!date) {
      errors.push({ line: lineNo, error: 'bad_date' });
      return;
    }
    if (amountCents == null || amountCents <= 0) {
      errors.push({ line: lineNo, error: 'bad_amount' });
      return;
    }
    lines.push({
      line: lineNo,
      clientCode: code,
      clientName: (r[idx('client_name')] ?? '').trim(),
      chargeDate: date,
      description: (r[idx('description')] ?? '').trim(),
      amountCents,
    });
  });
  return { lines, errors };
}

// ---- routes -----------------------------------------------------------

const PreviewSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  engagementTypeId: z.string().uuid(),
});

const CreateSchema = z.object({
  engagementTypeId: z.string().uuid(),
  paymentMethodKey: z.string().regex(/^[A-Z0-9_]{2,40}$/),
  paymentMethodLabel: z.string().min(1).max(80).optional(),
  fileName: z.string().max(300).optional(),
});

const RowOutcomeSchema = z.object({
  clientCode: z.string().min(1).max(80),
  clientName: z.string().max(300).optional().nullable(),
  chargeDate: z.string().regex(DATE_RE),
  description: z.string().max(1000).optional().nullable(),
  amountCents: z.number().int().positive(),
  clientId: z.string().uuid().optional().nullable(),
  engagementId: z.string().uuid().optional().nullable(),
  invoiceId: z.string().uuid().optional().nullable(),
  paymentReceiptId: z.string().uuid().optional().nullable(),
  creditMemoId: z.string().uuid().optional().nullable(),
  outcome: z.enum(['INVOICED_PAID', 'PREPAYMENT', 'SKIPPED']),
  detail: z.string().max(500).optional().nullable(),
});

const RowsSchema = z.object({ rows: z.array(RowOutcomeSchema).min(1).max(2000) });

export function createPaymentImportRouter(deps: PaymentImportRoutesDeps): Router {
  const router = express.Router();

  router.post(
    '/preview',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const parsed = PreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ groups: [], errors: [] });
        return;
      }
      const db = deps.db;
      const firmId = session.firmId;

      const [etype] = await db
        .select({ id: engagementTypes.id, name: engagementTypes.name })
        .from(engagementTypes)
        .where(
          and(
            eq(engagementTypes.id, parsed.data.engagementTypeId),
            eq(engagementTypes.firmId, firmId),
          ),
        )
        .limit(1);
      if (!etype) {
        res.status(404).json({ error: 'engagement_type_not_found' });
        return;
      }

      const { lines, errors } = parseLines(parsed.data.csv);
      const codes = [...new Set(lines.map((l) => l.clientCode))];

      // Client match: external_id first, then aws_id (filer rule).
      const clientRows = codes.length
        ? await db
            .select({
              id: clients.id,
              name: clients.name,
              externalId: clients.externalId,
              awsId: clients.awsId,
            })
            .from(clients)
            .where(
              and(
                eq(clients.firmId, firmId),
                or(inArray(clients.externalId, codes), inArray(clients.awsId, codes)),
              ),
            )
        : [];
      const byCode = new Map<string, { id: string; name: string }>();
      for (const code of codes) {
        const hit =
          clientRows.find((c) => c.externalId === code) ?? clientRows.find((c) => c.awsId === code);
        if (hit) byCode.set(code, { id: hit.id, name: hit.name });
      }

      // ACTIVE engagements of the chosen type for matched clients.
      const clientIds = [...new Set([...byCode.values()].map((c) => c.id))];
      const engRows = clientIds.length
        ? await db
            .select({ id: engagements.id, clientId: engagements.clientId, name: engagements.name })
            .from(engagements)
            .where(
              and(
                inArray(engagements.clientId, clientIds),
                eq(engagements.engagementTypeId, etype.id),
                eq(engagements.status, 'ACTIVE'),
              ),
            )
        : [];
      const engsByClient = new Map<string, { id: string; name: string }[]>();
      for (const e of engRows) {
        const list = engsByClient.get(e.clientId) ?? [];
        list.push({ id: e.id, name: e.name });
        engsByClient.set(e.clientId, list);
      }

      // Unbilled WIP per candidate engagement.
      const engIds = engRows.map((e) => e.id);
      const wipRows = engIds.length
        ? await db
            .select({
              engagementId: timeEntries.engagementId,
              wipCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)::bigint`,
              entryCount: sql<number>`COUNT(*)::int`,
            })
            .from(timeEntries)
            .where(
              and(inArray(timeEntries.engagementId, engIds), isNull(timeEntries.billingBatchId)),
            )
            .groupBy(timeEntries.engagementId)
        : [];
      const wipByEng = new Map(wipRows.map((w) => [w.engagementId, w]));

      // Duplicate probe against prior imported rows (non-SKIPPED).
      const dupRows = lines.length
        ? await db
            .select({
              clientCode: paymentImportRows.clientCode,
              chargeDate: paymentImportRows.chargeDate,
              description: paymentImportRows.description,
              amountCents: paymentImportRows.amountCents,
            })
            .from(paymentImportRows)
            .where(
              and(
                eq(paymentImportRows.firmId, firmId),
                inArray(paymentImportRows.clientCode, codes),
                sql`${paymentImportRows.outcome} <> 'SKIPPED'`,
              ),
            )
        : [];
      // The payroll system's description is unique per client payment, so
      // client + description + amount is the dedupe identity (date-proof
      // against re-exports). Blank descriptions fall back to the date.
      const dupKey = (c: string, d: string, desc: string, a: number): string =>
        desc ? `${c}|${desc}|${a}` : `${c}|${d}|${a}`;
      const dupSet = new Set(
        dupRows.map((r) =>
          dupKey(r.clientCode, r.chargeDate, r.description ?? '', Number(r.amountCents)),
        ),
      );

      // Firm adjustment-approval threshold + reason codes for the UI.
      const codesList = await db
        .select({ id: reasonCodes.id, category: reasonCodes.category, label: reasonCodes.label })
        .from(reasonCodes)
        .where(and(eq(reasonCodes.firmId, firmId), eq(reasonCodes.status, 'ACTIVE')));

      // Group by client code (unmatched group on the code itself).
      interface GroupRow extends ParsedLine {
        duplicate: boolean;
      }
      const groups = new Map<string, GroupRow[]>();
      for (const l of lines) {
        const g = groups.get(l.clientCode) ?? [];
        g.push({
          ...l,
          duplicate: dupSet.has(dupKey(l.clientCode, l.chargeDate, l.description, l.amountCents)),
        });
        groups.set(l.clientCode, g);
      }

      const out = [...groups.entries()].map(([code, rows]) => {
        const client = byCode.get(code) ?? null;
        const engs = (client ? (engsByClient.get(client.id) ?? []) : []).map((e) => ({
          ...e,
          wipCents: Number(wipByEng.get(e.id)?.wipCents ?? 0),
          wipEntryCount: Number(wipByEng.get(e.id)?.entryCount ?? 0),
        }));
        const engagement = engs.length === 1 ? engs[0]! : null;
        const wip = engagement ? wipByEng.get(engagement.id) : undefined;
        const live = rows.filter((r) => !r.duplicate);
        const targetCents = live.reduce((s, r) => s + r.amountCents, 0);
        const wipCents = wip ? Number(wip.wipCents) : 0;
        let plan: 'BILL_AND_PAY' | 'PREPAYMENT' | 'PICK_ENGAGEMENT' | 'UNMATCHED' | 'ALL_DUPLICATE';
        if (live.length === 0) plan = 'ALL_DUPLICATE';
        else if (!client) plan = 'UNMATCHED';
        else if (engs.length > 1) plan = 'PICK_ENGAGEMENT';
        else if (engagement && wipCents > 0) plan = 'BILL_AND_PAY';
        else plan = 'PREPAYMENT';
        return {
          clientCode: code,
          csvClientName: rows[0]!.clientName,
          client,
          engagements: engs,
          engagementId: engagement?.id ?? null,
          wipCents,
          wipEntryCount: wip ? Number(wip.entryCount) : 0,
          targetCents,
          adjustmentCents: plan === 'BILL_AND_PAY' ? targetCents - wipCents : 0,
          maxChargeDate: live.reduce((m, r) => (r.chargeDate > m ? r.chargeDate : m), '0000-00-00'),
          rows,
          plan,
        };
      });

      res.json({
        engagementType: etype,
        groups: out,
        errors,
        reasonCodes: codesList,
      });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      // Seed the payment-method catalog with the chosen key (idempotent)
      // so /payments/receive accepts it.
      await deps.db
        .insert(paymentMethodTypes)
        .values({
          firmId: session.firmId,
          key: parsed.data.paymentMethodKey,
          label: parsed.data.paymentMethodLabel ?? 'Payroll draft',
          active: true,
        })
        .onConflictDoNothing();
      const [row] = await deps.db
        .insert(paymentImports)
        .values({
          firmId: session.firmId,
          engagementTypeId: parsed.data.engagementTypeId,
          paymentMethodKey: parsed.data.paymentMethodKey,
          fileName: parsed.data.fileName ?? null,
          createdByAppUserId: session.appUserId,
        })
        .returning({ id: paymentImports.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'payment_import',
        entityId: row!.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
      }).catch(() => undefined);
      res.status(201).json({ id: row!.id });
    },
  );

  router.post(
    '/:id/rows',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const parsed = RowsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [imp] = await deps.db
        .select({ id: paymentImports.id })
        .from(paymentImports)
        .where(
          and(eq(paymentImports.id, req.params['id']!), eq(paymentImports.firmId, session.firmId)),
        )
        .limit(1);
      if (!imp) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.insert(paymentImportRows).values(
        parsed.data.rows.map((r) => ({
          importId: imp.id,
          firmId: session.firmId,
          clientCode: r.clientCode,
          clientName: r.clientName ?? null,
          chargeDate: r.chargeDate,
          description: r.description ?? null,
          amountCents: r.amountCents,
          clientId: r.clientId ?? null,
          engagementId: r.engagementId ?? null,
          invoiceId: r.invoiceId ?? null,
          paymentReceiptId: r.paymentReceiptId ?? null,
          creditMemoId: r.creditMemoId ?? null,
          outcome: r.outcome,
          detail: r.detail ?? null,
        })),
      );
      res.status(201).json({ ok: true, count: parsed.data.rows.length });
    },
  );

  router.get('/', requirePermission(deps, 'payment:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(paymentImports)
      .where(eq(paymentImports.firmId, session.firmId))
      .orderBy(desc(paymentImports.createdAt))
      .limit(50);
    res.json({ items });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [imp] = await deps.db
        .select()
        .from(paymentImports)
        .where(
          and(eq(paymentImports.id, req.params['id']!), eq(paymentImports.firmId, session.firmId)),
        )
        .limit(1);
      if (!imp) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await deps.db
        .select()
        .from(paymentImportRows)
        .where(eq(paymentImportRows.importId, imp.id))
        .orderBy(paymentImportRows.clientCode, paymentImportRows.chargeDate);
      res.json({ import: imp, rows });
    },
  );

  return router;
}
