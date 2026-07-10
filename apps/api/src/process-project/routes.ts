// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Process Project printing — from the Quick-log / Log-time view. Unlike
// the route sheet, printing a process project is NOT logged (no DB
// record):
//
//   GET  /engagement/:engagementId/prefill   suggested tax year (period)
//   POST /pdf                                 render the form → inline PDF
//
// The POST assembles the same client/contact/address + responsible
// lead(partner)/staff(manager)/period data as the route sheet, prints the
// staff-chosen delivery/documents/matching + tax year + notes, and
// streams the PDF. Gated on engagement:read (read-only, no mutation).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, clientContacts, clients, engagements, persons } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { renderHtmlToPdf } from '../pdf/render';
import {
  renderProcessProjectHtml,
  type ProcessProjectData,
} from '../pdf-templates/process-project';

export interface ProcessProjectRoutesDeps extends RbacDeps {
  db: Database | null;
  /** Test seam — defaults to the Puppeteer renderer. */
  renderPdf?: (html: string) => Promise<Buffer>;
}

function periodLabel(e: {
  periodLabel: string | null;
  periodYear: number | null;
  periodMonth: number | null;
}): string | null {
  if (e.periodLabel && e.periodLabel.trim()) return e.periodLabel;
  if (e.periodYear != null) {
    return e.periodMonth != null ? `${e.periodMonth}/${e.periodYear}` : String(e.periodYear);
  }
  return null;
}

function clientAddress(c: {
  mailingStreet1: string | null;
  mailingStreet2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostal: string | null;
  billingAddress: string | null;
}): string | null {
  const parts = [
    c.mailingStreet1,
    c.mailingStreet2,
    [c.mailingCity, c.mailingState, c.mailingPostal].filter(Boolean).join(', '),
  ]
    .filter((p) => p && p.trim())
    .join(', ');
  return parts || c.billingAddress || null;
}

export function createProcessProjectRouter(deps: ProcessProjectRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['engagementId']);
  const renderPdf = deps.renderPdf ?? renderHtmlToPdf;

  // Load the engagement (firm-scoped) + its client/contacts/staff and
  // merge the staff-supplied form values into the render payload.
  async function buildData(
    db: Database,
    firmId: string,
    engagementId: string,
    form: { taxYear: string; delivery: string; documents: string; matching: string; notes: string },
  ): Promise<ProcessProjectData | null> {
    const [e] = await db
      .select({
        clientId: engagements.clientId,
        partnerId: engagements.partnerId,
        managerId: engagements.managerId,
        periodLabel: engagements.periodLabel,
        periodYear: engagements.periodYear,
        periodMonth: engagements.periodMonth,
      })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    if (!e) return null;

    const [c] = await db
      .select({
        name: clients.name,
        mailingStreet1: clients.mailingStreet1,
        mailingStreet2: clients.mailingStreet2,
        mailingCity: clients.mailingCity,
        mailingState: clients.mailingState,
        mailingPostal: clients.mailingPostal,
        billingAddress: clients.billingAddress,
      })
      .from(clients)
      .where(and(eq(clients.id, e.clientId), eq(clients.firmId, firmId)))
      .limit(1);
    if (!c) return null; // engagement's client not in this firm → 404

    const staffName = async (id: string | null): Promise<string | null> => {
      if (!id) return null;
      const [u] = await db
        .select({ fullName: appUsers.fullName })
        .from(appUsers)
        .where(eq(appUsers.id, id))
        .limit(1);
      return u?.fullName ?? null;
    };
    const [responsibleLead, responsibleStaff] = await Promise.all([
      staffName(e.partnerId),
      staffName(e.managerId),
    ]);

    const contactRows = await db
      .select({
        cName: clientContacts.fullName,
        cEmail: clientContacts.email,
        cPhone: clientContacts.phone,
        cMobile: clientContacts.mobile,
        pName: persons.fullName,
        pEmail: persons.email,
        pPhone: persons.phone,
        pMobile: persons.mobile,
      })
      .from(clientContacts)
      .leftJoin(persons, eq(persons.id, clientContacts.personId))
      .where(eq(clientContacts.clientId, e.clientId))
      .orderBy(desc(clientContacts.isPrimary))
      .limit(2);
    const contacts = contactRows.map((r) => ({
      name: r.pName ?? r.cName ?? '',
      email: r.pEmail ?? r.cEmail ?? null,
      home: r.pPhone ?? r.cPhone ?? null,
      mobile: r.pMobile ?? r.cMobile ?? null,
    }));

    return {
      clientName: c.name,
      taxYear: form.taxYear,
      period: periodLabel(e),
      responsibleLead,
      responsibleStaff,
      delivery: form.delivery,
      documents: form.documents,
      matching: form.matching,
      notes: form.notes,
      address: clientAddress(c),
      contacts,
    };
  }

  // ── GET prefill (suggested tax year from the engagement period) ──────
  router.get(
    '/engagement/:engagementId/prefill',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ taxYear: null });
        return;
      }
      const [e] = await deps.db
        .select({ clientId: engagements.clientId, periodYear: engagements.periodYear })
        .from(engagements)
        .where(eq(engagements.id, req.params['engagementId']!))
        .limit(1);
      if (!e) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [c] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, e.clientId), eq(clients.firmId, firmId)))
        .limit(1);
      if (!c) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ taxYear: e.periodYear != null ? String(e.periodYear) : null });
    },
  );

  // ── POST render the form → inline PDF (no persistence) ───────────────
  const PdfSchema = z.object({
    engagementId: z.string().uuid(),
    taxYear: z.string().max(20).optional(),
    delivery: z.string().max(120).optional(),
    documents: z.string().max(120).optional(),
    matching: z.string().max(120).optional(),
    notes: z.string().max(4000).optional(),
  });

  router.post('/pdf', requirePermission(deps, 'engagement:read'), async (req, res) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = PdfSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    const data = await buildData(deps.db, firmId, parsed.data.engagementId, {
      taxYear: parsed.data.taxYear?.trim() ?? '',
      delivery: parsed.data.delivery?.trim() ?? '',
      documents: parsed.data.documents?.trim() ?? '',
      matching: parsed.data.matching?.trim() ?? '',
      notes: parsed.data.notes?.trim() ?? '',
    });
    if (!data) {
      res.status(404).json({ error: 'engagement_not_found' });
      return;
    }
    try {
      const pdf = await renderPdf(renderProcessProjectHtml(data));
      const name = data.clientName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="process-project-${name}.pdf"`);
      res.send(pdf);
    } catch (err) {
      logger.error({ err }, 'process-project render failed');
      res.status(502).json({ error: 'render_failed' });
    }
  });

  return router;
}
