// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-4 — Portal tax-return viewer endpoints.
//
// GET /api/portal/tax/returns                — list released returns
// GET /api/portal/tax/returns/:returnId/meta — viewer metadata
//                                              (sections sidebar +
//                                              release info)
// GET /api/portal/tax/returns/:returnId.pdf  — derived PDF bytes
//
// Critical security semantic per §6: when the staff used SELECTED
// scope, withheld sections do NOT appear in the sidebar — the client
// never sees they exist. We enforce this server-side: the meta
// endpoint returns only the sections in the release.section_ids
// array; the PDF endpoint passes the same set through
// planExtraction() so byte ranges outside the release are never
// rendered.
//
// The actual PDF rendering needs pdf-lib (TR-2). When PDF_LIB is
// unavailable (no STORAGE_PROVIDER configured, dep not installed),
// the .pdf endpoint responds 503 with a clear message rather than
// returning the original PDF — never serve unscoped bytes.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  files,
  portalIdentity,
  taxReturnReleases,
  taxReturnSections,
  taxReturns,
  taxReturnShares,
} from '@vibe/db/schema';
import { planExtraction, type SectionPageRange } from '@vibe/core/tax-returns';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { resolveScope } from './scope';
import { appendAccessLog, listAccessLog } from '../tax-returns/access-log';
import { renderScopedReturnPdf, RenderError } from '../tax-returns/render';

export interface PortalTaxReturnDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  // Tests inject a fake; production resolves lazily per-request so it
  // picks up the B2 creds hydrated into process.env after boot. The
  // .pdf endpoint renders the scoped, watermarked subset; with no
  // storage it falls closed to 503 (never serves source bytes).
  storage?: StorageClient | null;
}

function resolveStorage(deps: PortalTaxReturnDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

interface ReleasedReturnView {
  returnId: string;
  releaseId: string;
  taxYear: number;
  formCode: string;
  jurisdiction: string;
  title: string;
  totalPages: number | null;
  releasedAt: string;
  releaseKind: 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED';
  clientCanDownload: boolean;
  coverNote: string | null;
  scope: 'FULL' | 'SELECTED';
}

export function createPortalTaxReturnRouter(deps: PortalTaxReturnDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['returnId']);

  // List every live release scoped to the session's client(s).
  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    if (scope.clientIds.length === 0) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select({
        returnId: taxReturns.id,
        releaseId: taxReturnReleases.id,
        taxYear: taxReturns.taxYear,
        formCode: taxReturns.formCode,
        jurisdiction: taxReturns.jurisdiction,
        title: taxReturns.title,
        totalPages: taxReturns.totalPages,
        releasedAt: taxReturnReleases.releasedAt,
        releaseKind: taxReturns.releaseKind,
        clientCanDownload: taxReturnReleases.clientCanDownload,
        coverNote: taxReturnReleases.coverNote,
        scope: taxReturnReleases.scope,
      })
      .from(taxReturnReleases)
      .innerJoin(taxReturns, eq(taxReturns.id, taxReturnReleases.returnId))
      .where(
        and(
          inArray(taxReturnReleases.releasedToClientId, scope.clientIds),
          isNull(taxReturnReleases.revokedAt),
        ),
      );
    const items: ReleasedReturnView[] = rows.map((r) => ({
      returnId: r.returnId,
      releaseId: r.releaseId,
      taxYear: r.taxYear,
      formCode: r.formCode,
      jurisdiction: r.jurisdiction,
      title: r.title,
      totalPages: r.totalPages,
      releasedAt: r.releasedAt.toISOString(),
      releaseKind: r.releaseKind as 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED',
      clientCanDownload: r.clientCanDownload,
      coverNote: r.coverNote,
      scope: r.scope as 'FULL' | 'SELECTED',
    }));
    res.json({ items });
  });

  // Viewer metadata for a single return.
  router.get('/:returnId/meta', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    const releaseRow = await loadReleaseForCaller(
      deps.db,
      req.params['returnId']!,
      scope.clientIds,
    );
    if (!releaseRow) {
      res.status(404).json({ error: 'release_not_found' });
      return;
    }
    // Load sections, then filter by release scope.
    const allSections = await deps.db
      .select({
        id: taxReturnSections.id,
        ordinal: taxReturnSections.ordinal,
        depth: taxReturnSections.depth,
        parentSectionId: taxReturnSections.parentSectionId,
        normalizedTitle: taxReturnSections.normalizedTitle,
        kind: taxReturnSections.kind,
        startPage: taxReturnSections.startPage,
        endPage: taxReturnSections.endPage,
        recipientName: taxReturnSections.recipientName,
      })
      .from(taxReturnSections)
      .where(eq(taxReturnSections.returnId, releaseRow.returnId));
    const visibleSectionIds =
      releaseRow.scope === 'FULL'
        ? new Set(allSections.map((s) => s.id))
        : new Set(releaseRow.sectionIds);
    const sections = allSections
      .filter((s) => visibleSectionIds.has(s.id))
      .sort((a, b) => a.ordinal - b.ordinal);

    // List the client's own active shares of this release so the
    // viewer can render the "Shared with" rail.
    const shares = await deps.db
      .select({
        id: taxReturnShares.id,
        recipientName: taxReturnShares.recipientName,
        recipientEmail: taxReturnShares.recipientEmail,
        organization: taxReturnShares.organization,
        status: taxReturnShares.status,
        viewCount: taxReturnShares.viewCount,
        lastViewedAt: taxReturnShares.lastViewedAt,
        expiresAt: taxReturnShares.expiresAt,
        revokedAt: taxReturnShares.revokedAt,
      })
      .from(taxReturnShares)
      .where(
        and(eq(taxReturnShares.releaseId, releaseRow.releaseId), isNull(taxReturnShares.revokedAt)),
      );

    res.json({
      return: {
        id: releaseRow.returnId,
        taxYear: releaseRow.taxYear,
        formCode: releaseRow.formCode,
        jurisdiction: releaseRow.jurisdiction,
        title: releaseRow.title,
        totalPages: releaseRow.totalPages,
        releaseKind: releaseRow.releaseKind,
      },
      release: {
        id: releaseRow.releaseId,
        scope: releaseRow.scope,
        clientCanDownload: releaseRow.clientCanDownload,
        coverNote: releaseRow.coverNote,
        releasedAt: releaseRow.releasedAt.toISOString(),
      },
      sections: sections.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        depth: s.depth,
        parentSectionId: s.parentSectionId,
        title: s.normalizedTitle,
        kind: s.kind,
        startPage: s.startPage,
        endPage: s.endPage,
        recipientName: s.recipientName,
      })),
      shares: shares.map((s) => ({
        id: s.id,
        recipientName: s.recipientName,
        recipientEmail: s.recipientEmail,
        organization: s.organization,
        status: s.status,
        viewCount: s.viewCount,
        lastViewedAt: s.lastViewedAt?.toISOString() ?? null,
        expiresAt: s.expiresAt.toISOString(),
      })),
    });
  });

  // TR-8 — client-facing access history.
  router.get('/:returnId/access-log', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [], nextCursor: null });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    const releaseRow = await loadReleaseForCaller(
      deps.db,
      req.params['returnId']!,
      scope.clientIds,
    );
    if (!releaseRow) {
      res.status(404).json({ error: 'release_not_found' });
      return;
    }
    // Look up the firm via the return itself.
    const cursorRaw = req.query['cursor'];
    let cursor: { at: string; id: string } | null = null;
    if (typeof cursorRaw === 'string' && cursorRaw.length > 0) {
      try {
        cursor = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
      } catch {
        res.status(400).json({ error: 'bad_cursor' });
        return;
      }
    }
    // We need the firmId for the scope guard. Pull from the
    // return row.
    const [retRow] = await deps.db
      .select({ firmId: taxReturns.firmId })
      .from(taxReturns)
      .where(eq(taxReturns.id, releaseRow.returnId))
      .limit(1);
    if (!retRow) {
      res.status(404).json({ error: 'release_not_found' });
      return;
    }
    const result = await listAccessLog({
      db: deps.db,
      returnId: releaseRow.returnId,
      firmId: retRow.firmId,
      cursor,
      pageSize: 50,
      clientVisibleOnly: true, // hide PARSED, SECTION_EDITED
    });
    const nextCursor =
      result.nextCursor === null
        ? null
        : Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url');
    res.json({ items: result.items, nextCursor });
  });

  // PDF endpoint — plans the extraction, then either delegates to a
  // configured renderer or returns 503. We never fall back to the
  // original PDF here.
  router.get('/:returnId.pdf', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    const releaseRow = await loadReleaseForCaller(
      deps.db,
      req.params['returnId']!,
      scope.clientIds,
    );
    if (!releaseRow) {
      res.status(404).json({ error: 'release_not_found' });
      return;
    }
    const allSections = await deps.db
      .select({
        id: taxReturnSections.id,
        ordinal: taxReturnSections.ordinal,
        startPage: taxReturnSections.startPage,
        endPage: taxReturnSections.endPage,
      })
      .from(taxReturnSections)
      .where(eq(taxReturnSections.returnId, releaseRow.returnId));
    const catalog: SectionPageRange[] = allSections.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      startPage: s.startPage,
      endPage: s.endPage,
    }));
    // Watermark the client by their email (or phone) — never the raw
    // client UUID. If the identity row is somehow missing, fall back to a
    // generic non-identifying label rather than stamping a UUID.
    let watermarkPrimary = 'Client copy';
    const [ident] = await deps.db
      .select({ email: portalIdentity.primaryEmail, phone: portalIdentity.primaryPhone })
      .from(portalIdentity)
      .where(eq(portalIdentity.id, session.portalIdentityId))
      .limit(1);
    if (ident) watermarkPrimary = ident.email || ident.phone || 'Client copy';

    let plan;
    try {
      plan = planExtraction({
        returnId: releaseRow.returnId,
        anchorId: releaseRow.releaseId,
        scope: releaseRow.scope,
        sectionIds: releaseRow.scope === 'FULL' ? [] : releaseRow.sectionIds,
        sectionCatalog: catalog,
        totalPages: releaseRow.totalPages ?? 1,
        watermark: {
          audience: 'CLIENT',
          timestamp: new Date().toISOString(),
          primary: watermarkPrimary,
        },
      });
    } catch (err) {
      res.status(400).json({ error: 'extract_plan_failed', detail: (err as Error).message });
      return;
    }
    // TR-8b — audit. Even a 503 from the renderer means the client
    // *attempted* to view; that's an audit-worthy event.
    await appendAccessLog({
      db: deps.db,
      returnId: releaseRow.returnId,
      event: 'VIEW',
      actorKind: 'CLIENT',
      // The portal identity (resolvable to email/name) — the access-log
      // viewer shows the persona who viewed, not a raw id.
      actorRef: session.portalIdentityId,
      actorIp: req.ip ?? null,
      actorUserAgent: req.get('user-agent') ?? null,
      metadata: {
        pages: plan.pageIndices1Based.length,
        scope: releaseRow.scope,
        clientId: session.activeClientId,
      },
    }).catch(() => undefined);

    // Fall closed: with no storage client or a deleted source file we
    // never serve the original — return 503 instead.
    const storage = resolveStorage(deps);
    if (!storage || !releaseRow.sourceStorageKey) {
      res.status(503).json({
        error: 'pdf_renderer_unavailable',
        pages: plan.pageIndices1Based.length,
        cacheKey: plan.cacheKey,
        watermark: plan.watermarkText,
      });
      return;
    }
    try {
      const pdf = await renderScopedReturnPdf({
        storage,
        sourceStorageKey: releaseRow.sourceStorageKey,
        pageIndices1Based: plan.pageIndices1Based,
        watermarkText: plan.watermarkText,
      });
      const filename = `${releaseRow.taxYear} ${releaseRow.formCode} ${releaseRow.jurisdiction}.pdf`;
      res.status(200);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    } catch (err) {
      const code = err instanceof RenderError ? err.code : 'render_failed';
      logger.warn({ err, returnId: releaseRow.returnId }, 'tax-return render failed');
      res.status(502).json({ error: 'pdf_render_failed', detail: code });
    }
  });

  return router;
}

interface ReleaseRowForCaller {
  returnId: string;
  releaseId: string;
  taxYear: number;
  formCode: string;
  jurisdiction: string;
  title: string;
  totalPages: number | null;
  releaseKind: 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED';
  releasedAt: Date;
  scope: 'FULL' | 'SELECTED';
  sectionIds: string[];
  clientCanDownload: boolean;
  coverNote: string | null;
  // Source PDF location — null when the file row was deleted.
  sourceStorageKey: string | null;
}

async function loadReleaseForCaller(
  db: Database,
  returnId: string,
  callerClientIds: string[],
): Promise<ReleaseRowForCaller | null> {
  if (callerClientIds.length === 0) return null;
  const [row] = await db
    .select({
      returnId: taxReturns.id,
      releaseId: taxReturnReleases.id,
      taxYear: taxReturns.taxYear,
      formCode: taxReturns.formCode,
      jurisdiction: taxReturns.jurisdiction,
      title: taxReturns.title,
      totalPages: taxReturns.totalPages,
      releaseKind: taxReturns.releaseKind,
      releasedAt: taxReturnReleases.releasedAt,
      scope: taxReturnReleases.scope,
      sectionIds: taxReturnReleases.sectionIds,
      clientCanDownload: taxReturnReleases.clientCanDownload,
      coverNote: taxReturnReleases.coverNote,
      sourceStorageKey: files.storageKey,
      sourceDeletedAt: files.deletedAt,
    })
    .from(taxReturnReleases)
    .innerJoin(taxReturns, eq(taxReturns.id, taxReturnReleases.returnId))
    .leftJoin(files, eq(files.id, taxReturns.sourceFileId))
    .where(
      and(
        eq(taxReturnReleases.returnId, returnId),
        inArray(taxReturnReleases.releasedToClientId, callerClientIds),
        isNull(taxReturnReleases.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    returnId: row.returnId,
    releaseId: row.releaseId,
    taxYear: row.taxYear,
    formCode: row.formCode,
    jurisdiction: row.jurisdiction,
    title: row.title,
    totalPages: row.totalPages,
    releaseKind: row.releaseKind as 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED',
    releasedAt: row.releasedAt,
    scope: row.scope as 'FULL' | 'SELECTED',
    sectionIds: row.sectionIds as string[],
    clientCanDownload: row.clientCanDownload,
    coverNote: row.coverNote,
    sourceStorageKey: row.sourceDeletedAt ? null : row.sourceStorageKey,
  };
}
