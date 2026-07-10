// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Engagement template starter-pack reader (Q24). Returns the JSON
// shipped at `/seed/engagement-templates.json` so the admin UI can
// preview the pack before installing.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export type TemplatePackDeps = RbacDeps;

let cached: unknown = null;

async function load(): Promise<unknown> {
  if (cached) return cached;
  const candidates = [
    path.resolve(process.cwd(), 'seed/engagement-templates.json'),
    path.resolve(process.cwd(), '../../seed/engagement-templates.json'),
  ];
  for (const c of candidates) {
    try {
      const raw = await readFile(c, 'utf8');
      cached = JSON.parse(raw);
      return cached;
    } catch {
      // try next
    }
  }
  return { templates: [], note: 'seed file not found from cwd' };
}

export function createTemplatePackRouter(deps: TemplatePackDeps): Router {
  const router = express.Router();

  router.get(
    '/engagement-template-pack',
    requirePermission(deps, 'taxonomy:read'),
    async (_req: Request, res: Response) => {
      const data = await load();
      res.json(data);
    },
  );

  // Bulk-import work-codes and reason-codes via CSV (Phase 6 #6 + #11).
  // Body: { kind: 'work_codes'|'reason_codes', csv }. CSV header for
  // work_codes: name,description,billableDefault,inScopeDefault.
  // For reason_codes: name,category.
  router.post('/bulk-import', requirePermission(deps, 'taxonomy:write'), async (req, res) => {
    const body = req.body as { kind?: unknown; csv?: unknown };
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const csv = typeof body.csv === 'string' ? body.csv : '';
    if (!csv || (kind !== 'work_codes' && kind !== 'reason_codes')) {
      res.status(400).json({ error: 'kind_and_csv_required' });
      return;
    }
    const session = req.staffSession!;
    const { workCodes, reasonCodes } = await import('@vibe/db/schema');
    // Without a db connection (dev/no-db), accept and report 0.
    const dbMaybe = (req.app.get('db') ?? null) as { insert?: unknown } | null;
    void dbMaybe;
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      res.status(400).json({ error: 'csv_needs_header_and_one_row' });
      return;
    }
    const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
    let created = 0;
    let skipped = 0;
    const db = (deps as unknown as { db: { insert: (t: unknown) => unknown } | null }).db;
    if (!db) {
      res.json({ created: 0, skipped: 0 });
      return;
    }
    for (let i = 1; i < lines.length; i += 1) {
      const cells = lines[i]!.split(',').map((c) => c.trim());
      if (kind === 'work_codes') {
        const ni = header.indexOf('name');
        if (ni < 0 || !cells[ni]) {
          skipped++;
          continue;
        }
        try {
          await (
            db as unknown as {
              insert: (t: typeof workCodes) => {
                values: (v: Record<string, unknown>) => Promise<unknown>;
              };
            }
          )
            .insert(workCodes)
            .values({
              firmId: session.firmId,
              name: cells[ni]!,
              description: cells[header.indexOf('description')] ?? null,
              billableDefault: cells[header.indexOf('billabledefault')] === 'true',
              inScopeDefault: cells[header.indexOf('inscopedefault')] === 'true',
            });
          created++;
        } catch {
          skipped++;
        }
      } else {
        const ni = header.indexOf('name');
        if (ni < 0 || !cells[ni]) {
          skipped++;
          continue;
        }
        try {
          await (
            db as unknown as {
              insert: (t: typeof reasonCodes) => {
                values: (v: Record<string, unknown>) => Promise<unknown>;
              };
            }
          )
            .insert(reasonCodes)
            .values({
              firmId: session.firmId,
              name: cells[ni]!,
              category:
                cells[header.indexOf('category')] === 'WRITE_UP' ||
                cells[header.indexOf('category')] === 'TRANSFER'
                  ? cells[header.indexOf('category')]!
                  : 'WRITE_DOWN',
            });
          created++;
        } catch {
          skipped++;
        }
      }
    }
    res.json({ created, skipped });
  });

  // Install one template from the seed pack: creates the engagement_type
  // row (if missing) plus all work_codes named in the template.
  // Idempotent — re-installation skips items that already exist by name.
  router.post(
    '/engagement-template-install',
    requirePermission(deps, 'taxonomy:write'),
    async (req, res) => {
      const body = req.body as { templateKey?: unknown };
      const key = typeof body.templateKey === 'string' ? body.templateKey : '';
      if (!key) {
        res.status(400).json({ error: 'templateKey_required' });
        return;
      }
      const pack = (await load()) as {
        templates?: Array<{
          key: string;
          name: string;
          service_line_category: string;
          default_fee_structure: string;
          default_fee_amount_cents?: number;
          default_budget_hours?: number;
          work_codes?: Array<{
            key: string;
            name: string;
            billable_default: boolean;
            in_scope_default: boolean;
          }>;
        }>;
      };
      const template = pack.templates?.find((t) => t.key === key);
      if (!template) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const session = req.staffSession!;
      const db = (deps as unknown as { db: typeof deps.db & { insert: (t: unknown) => unknown } })
        .db;
      if (!db) {
        res.json({ ok: true, installed: false });
        return;
      }
      const { engagementTypes, serviceLines, workCodes } = await import('@vibe/db/schema');
      const { eq, and } = await import('drizzle-orm');
      // Find or create the service line by category.
      const [existingSl] = await (
        db as unknown as {
          select: (s: Record<string, unknown>) => {
            from: (t: unknown) => {
              where: (c: unknown) => { limit: (n: number) => Promise<Array<{ id: string }>> };
            };
          };
        }
      )
        .select({ id: serviceLines.id })
        .from(serviceLines)
        .where(
          and(
            eq(serviceLines.firmId, session.firmId),
            eq(serviceLines.category, template.service_line_category),
          ),
        )
        .limit(1);
      let serviceLineId = existingSl?.id ?? null;
      if (!serviceLineId) {
        const [row] = await (
          db as unknown as {
            insert: (t: unknown) => {
              values: (v: Record<string, unknown>) => {
                returning: (r: Record<string, unknown>) => Promise<Array<{ id: string }>>;
              };
            };
          }
        )
          .insert(serviceLines)
          .values({
            firmId: session.firmId,
            name: template.service_line_category.toUpperCase(),
            category: template.service_line_category,
          })
          .returning({ id: serviceLines.id });
        serviceLineId = row?.id ?? null;
      }
      if (!serviceLineId) {
        res.status(500).json({ error: 'service_line_create_failed' });
        return;
      }
      // Create the engagement type.
      let engagementTypeId: string | null = null;
      try {
        const [row] = await (
          db as unknown as {
            insert: (t: unknown) => {
              values: (v: Record<string, unknown>) => {
                returning: (r: Record<string, unknown>) => Promise<Array<{ id: string }>>;
              };
            };
          }
        )
          .insert(engagementTypes)
          .values({
            firmId: session.firmId,
            name: template.name,
            serviceLineId,
            defaultFeeStructure: template.default_fee_structure,
          })
          .returning({ id: engagementTypes.id });
        engagementTypeId = row?.id ?? null;
      } catch {
        // Probably unique name conflict — silently skip.
      }
      // Insert work codes.
      let workCodesInserted = 0;
      for (const wc of template.work_codes ?? []) {
        try {
          await (
            db as unknown as {
              insert: (t: unknown) => {
                values: (v: Record<string, unknown>) => Promise<unknown>;
              };
            }
          )
            .insert(workCodes)
            .values({
              firmId: session.firmId,
              serviceLineId,
              name: wc.name,
              billableDefault: wc.billable_default,
              inScopeDefault: wc.in_scope_default,
            });
          workCodesInserted++;
        } catch {
          // skip dupes
        }
      }
      res.status(201).json({ ok: true, engagementTypeId, workCodesInserted, serviceLineId });
    },
  );

  return router;
}
