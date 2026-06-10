// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Assemble an in-office signature package from a tax return. Bookmarks locate
// the signature page(s) (federal 8879, state e-file authorizations); the firm
// may also append default-document templates (consents, engagement letters)
// and ad-hoc one-off PDFs. The selected pages/docs are merged into ONE PDF
// (pdf-lib copyPages), default role-tagged signature fields are auto-placed,
// and a draft signature_request is created linked back to the return. The
// client then signs the merged package once, in office.

import { and, eq, inArray } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import type { Readable } from 'node:stream';

import type { Database } from '@vibe/db';
import {
  files,
  signatureDocumentTemplates,
  signatureFieldPlacements,
  signaturePageRules,
  signatureRequests,
  signatureSigners,
  taxReturns,
} from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';
import {
  matchSignaturePages,
  ruleAppliesToReturn,
  type SignaturePageRule,
} from '@vibe/core/signatures';

import { parseSectionsFromPdf } from './parse';
import { capturePageGeometry, type PageGeometry } from '../signatures/geometry';
import {
  assemblePackagePlan,
  layoutForKey,
  signatureFormTypeForReturn,
  type PackagePart,
} from '../signatures/packaging';
import type { ProfileField } from '../signatures/profiles';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

async function loadBytes(storage: StorageClient, key: string): Promise<Buffer> {
  const obj = await storage.get(key);
  return streamToBuffer(obj.body as Readable);
}

interface ReturnRow {
  id: string;
  clientId: string;
  formCode: string;
  title: string;
  sourceStorageKey: string | null;
}

async function loadReturn(
  db: Database,
  firmId: string,
  returnId: string,
): Promise<ReturnRow | null> {
  const [row] = await db
    .select({
      id: taxReturns.id,
      clientId: taxReturns.clientId,
      formCode: taxReturns.formCode,
      title: taxReturns.title,
      sourceStorageKey: files.storageKey,
    })
    .from(taxReturns)
    .leftJoin(files, eq(files.id, taxReturns.sourceFileId))
    .where(and(eq(taxReturns.id, returnId), eq(taxReturns.firmId, firmId)))
    .limit(1);
  return row ?? null;
}

async function loadRules(db: Database, firmId: string): Promise<SignaturePageRule[]> {
  const rows = await db
    .select()
    .from(signaturePageRules)
    .where(eq(signaturePageRules.firmId, firmId));
  return rows.map((r) => ({
    id: r.id,
    formType: r.formType,
    bookmarkPattern: r.bookmarkPattern,
    matchMode: r.matchMode as SignaturePageRule['matchMode'],
    caseSensitive: r.caseSensitive,
    layoutKey: r.layoutKey,
    enabled: r.enabled,
    sortOrder: r.sortOrder,
  }));
}

export interface DetectResult {
  formCode: string;
  signatureFormType: string;
  pages: Array<{ pageNumber: number; bookmarkTitle: string; layoutKey: string }>;
  templates: Array<{ id: string; name: string; totalPages: number; autoInclude: boolean }>;
  noRulesConfigured: boolean;
  noSource: boolean;
}

/** Detect signature pages + applicable default templates (no writes). */
export async function detectSignaturePagesForReturn(
  db: Database,
  storage: StorageClient | null,
  firmId: string,
  returnId: string,
): Promise<DetectResult | null> {
  const ret = await loadReturn(db, firmId, returnId);
  if (!ret) return null;

  const rules = await loadRules(db, firmId);
  let pages: DetectResult['pages'] = [];
  let noSource = false;
  if (ret.sourceStorageKey && storage) {
    try {
      const bytes = await loadBytes(storage, ret.sourceStorageKey);
      const parsed = await parseSectionsFromPdf(bytes);
      pages = matchSignaturePages(parsed.sections, rules, ret.formCode).map((m) => ({
        pageNumber: m.pageNumber,
        bookmarkTitle: m.bookmarkTitle,
        layoutKey: m.layoutKey,
      }));
    } catch {
      noSource = true;
    }
  } else {
    noSource = true;
  }

  const templateRows = await db
    .select()
    .from(signatureDocumentTemplates)
    .where(
      and(
        eq(signatureDocumentTemplates.firmId, firmId),
        eq(signatureDocumentTemplates.enabled, true),
      ),
    );
  const templates = templateRows
    .filter((t) => ruleAppliesToReturn(t.formType, ret.formCode))
    .map((t) => ({ id: t.id, name: t.name, totalPages: t.totalPages, autoInclude: t.autoInclude }));

  return {
    formCode: ret.formCode,
    signatureFormType: signatureFormTypeForReturn(ret.formCode),
    pages,
    templates,
    noRulesConfigured: rules.length === 0,
    noSource,
  };
}

export interface CreatePackageSigner {
  name: string;
  email: string;
  role: string; // taxpayer | spouse | officer
  personId?: string | null;
  clientContactId?: string | null;
  portalIdentityId?: string | null;
}

export interface CreatePackageArgs {
  firmId: string;
  returnId: string;
  actorId: string;
  signers: CreatePackageSigner[];
  returnPages: Array<{ page: number; layoutKey: string }>;
  templateIds: string[];
  /** Storage keys of ad-hoc one-off PDFs uploaded for this session (under the
   *  firm's signatures/adhoc/ prefix). */
  adHocKeys: string[];
}

export type CreatePackageResult =
  | { ok: true; requestId: string }
  | { ok: false; code: 'not_found' | 'no_source' | 'empty_package' | 'no_signers' };

/** Merge the selected return pages + templates + ad-hoc docs into one draft
 *  signature request with auto-placed role-tagged fields. */
export async function createSignaturePackageFromReturn(
  db: Database,
  storage: StorageClient,
  args: CreatePackageArgs,
): Promise<CreatePackageResult> {
  if (args.signers.length === 0) return { ok: false, code: 'no_signers' };
  const ret = await loadReturn(db, args.firmId, args.returnId);
  if (!ret) return { ok: false, code: 'not_found' };

  const merged = await PDFDocument.create();
  const parts: PackagePart[] = [];

  // 1. Return signature pages (each its own part with its layout).
  if (args.returnPages.length > 0) {
    if (!ret.sourceStorageKey) return { ok: false, code: 'no_source' };
    const src = await PDFDocument.load(await loadBytes(storage, ret.sourceStorageKey), {
      ignoreEncryption: true,
    });
    const pageCount = src.getPageCount();
    for (const rp of args.returnPages) {
      if (rp.page < 1 || rp.page > pageCount) continue;
      const before = merged.getPageCount();
      const [pg] = await merged.copyPages(src, [rp.page - 1]);
      merged.addPage(pg);
      parts.push({
        source: 'return',
        label: `Return p.${rp.page}`,
        pageStart: before + 1,
        pageEnd: before + 1,
        fields: layoutForKey(rp.layoutKey),
      });
    }
  }

  // 2. Firm default-document templates.
  if (args.templateIds.length > 0) {
    const tmpls = await db
      .select()
      .from(signatureDocumentTemplates)
      .where(
        and(
          eq(signatureDocumentTemplates.firmId, args.firmId),
          inArray(signatureDocumentTemplates.id, args.templateIds),
        ),
      );
    const byId = new Map(tmpls.map((t) => [t.id, t]));
    for (const tid of args.templateIds) {
      const t = byId.get(tid);
      if (!t) continue;
      const doc = await PDFDocument.load(await loadBytes(storage, t.storageKey), {
        ignoreEncryption: true,
      });
      const idxs = doc.getPageIndices();
      const before = merged.getPageCount();
      const pages = await merged.copyPages(doc, idxs);
      pages.forEach((p) => merged.addPage(p));
      const saved = (t.fields as ProfileField[] | null) ?? [];
      parts.push({
        source: 'template',
        label: t.name,
        pageStart: before + 1,
        pageEnd: before + idxs.length,
        fields: saved.length > 0 ? saved : layoutForKey('generic'),
        refId: t.id,
      });
    }
  }

  // 3. Ad-hoc one-off documents (uploaded for this session). Keys are scoped
  // to the firm's adhoc prefix so a caller can't merge arbitrary objects.
  const adhocPrefix = `signatures/adhoc/${args.firmId}/`;
  for (const key of args.adHocKeys) {
    if (!key.startsWith(adhocPrefix)) continue;
    const doc = await PDFDocument.load(await loadBytes(storage, key), { ignoreEncryption: true });
    const idxs = doc.getPageIndices();
    const before = merged.getPageCount();
    const pages = await merged.copyPages(doc, idxs);
    pages.forEach((p) => merged.addPage(p));
    parts.push({
      source: 'adhoc',
      label: 'Attached document',
      pageStart: before + 1,
      pageEnd: before + idxs.length,
      fields: layoutForKey('generic'),
      refId: key,
    });
  }

  if (parts.length === 0) return { ok: false, code: 'empty_package' };

  const mergedBytes = Buffer.from(await merged.save());
  const geometry: PageGeometry[] = await capturePageGeometry(mergedBytes);
  const formType = signatureFormTypeForReturn(ret.formCode);

  // Create the request, then upload the merged source under its id, then
  // place fields. (sourceFileKey embeds the request id.)
  const [reqRow] = await db
    .insert(signatureRequests)
    .values({
      firmId: args.firmId,
      clientId: ret.clientId,
      taxReturnId: ret.id,
      title: `${ret.title} — signatures`,
      formType,
      pageGeometry: geometry,
      signerCount: args.signers.length,
      packageManifest: parts.map((p) => ({
        source: p.source,
        label: p.label,
        pageStart: p.pageStart,
        pageEnd: p.pageEnd,
        refId: p.refId ?? null,
      })),
      createdBy: args.actorId,
    })
    .returning({ id: signatureRequests.id });
  const requestId = reqRow!.id;

  const sourceKey = `signatures/${args.firmId}/${requestId}/source.pdf`;
  await storage.put(sourceKey, mergedBytes, { contentType: 'application/pdf' });
  await db
    .update(signatureRequests)
    .set({ sourceFileKey: sourceKey })
    .where(eq(signatureRequests.id, requestId));

  const signerRows = await db
    .insert(signatureSigners)
    .values(
      args.signers.map((s, i) => ({
        requestId,
        name: s.name,
        email: s.email,
        role: s.role,
        order: i + 1,
        personId: s.personId ?? null,
        clientContactId: s.clientContactId ?? null,
        portalIdentityId: s.portalIdentityId ?? null,
      })),
    )
    .returning({ id: signatureSigners.id, role: signatureSigners.role });

  const plan = assemblePackagePlan(parts, signerRows, geometry);
  if (plan.placements.length > 0) {
    await db.insert(signatureFieldPlacements).values(
      plan.placements.map((p) => ({
        requestId,
        signerId: p.signerId,
        fieldType: p.fieldType,
        pageNumber: p.pageNumber,
        nx: p.nx,
        ny: p.ny,
        nw: p.nw,
        nh: p.nh,
        required: p.required,
      })),
    );
  }

  return { ok: true, requestId };
}
