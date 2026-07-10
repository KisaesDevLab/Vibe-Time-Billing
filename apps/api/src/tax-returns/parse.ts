// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-1 automated parser — turns a source tax-return PDF into structured
// `tax_return_sections`. Two strategies, best first:
//
//   1. Bookmark outline (the norm for UltraTax/Lacerte/ProSeries/Drake
//      exports): pdfjs `getOutline()` → resolve each item's destination
//      to a 1-based start page → OutlineNode tree → walkOutline().
//   2. Header-detection fallback (flattened/scanned PDFs with no
//      bookmarks): scan each page's top text for a form header the
//      lexicon recognises, at downgraded confidence.
//
// The pure planning pieces (normalizeTitle, walkOutline) live in
// @vibe/core/tax-returns and are unit-tested there; this module owns the
// pdfjs integration + persistence. `detectSectionsFromHeaders` is kept
// pure so the fallback heuristic is testable without a PDF.

import type { Readable } from 'node:stream';

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { taxReturns, taxReturnSections } from '@vibe/db/schema';
import {
  type FlatSection,
  normalizeTitle,
  type OutlineNode,
  walkOutline,
} from '@vibe/core/tax-returns';
import type { StorageClient } from '@vibe/storage';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { logger } from '../logger';

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export interface ParsedSections {
  totalPages: number;
  sections: FlatSection[];
  /** 'outline' when bookmarks drove it, 'headers' for the text fallback,
   *  'single' when neither produced anything (one catch-all section). */
  strategy: 'outline' | 'headers' | 'single';
}

/**
 * Pure fallback heuristic: given the concatenated text of each page (in
 * order, index 0 = page 1), start a new section wherever a page's top
 * text matches a known form header. Continuation pages fold into the
 * preceding section. Returns flat OutlineNodes for walkOutline().
 */
export function detectSectionsFromHeaders(pageTexts: string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const head = (pageTexts[i] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!head) continue;
    const norm = normalizeTitle(head);
    if (norm.kind === 'UNKNOWN') continue;
    nodes.push({ title: head, startPage: i + 1 });
  }
  return nodes;
}

/** Resolve a pdfjs outline destination to a 1-based page number. */
async function resolveStartPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    let explicit = dest;
    if (typeof explicit === 'string') explicit = await doc.getDestination(explicit);
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    if (ref == null) return null;
    if (typeof ref === 'number') return ref + 1; // some dests carry a page index
    const idx = await doc.getPageIndex(ref);
    return idx + 1;
  } catch {
    return null;
  }
}

interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineItem[];
}

async function toOutlineNode(
  doc: PDFDocumentProxy,
  item: RawOutlineItem,
): Promise<OutlineNode | null> {
  const childNodes: OutlineNode[] = [];
  for (const child of item.items ?? []) {
    const node = await toOutlineNode(doc, child);
    if (node) childNodes.push(node);
  }
  const start = await resolveStartPage(doc, item.dest);
  const title = (item.title ?? '').trim() || 'Untitled';
  if (start == null) {
    // No page of its own — keep it only as a grouping for its children,
    // anchored at the first child's page.
    if (childNodes.length === 0) return null;
    return { title, startPage: childNodes[0]!.startPage, children: childNodes };
  }
  return { title, startPage: start, children: childNodes.length ? childNodes : undefined };
}

/** Extract section structure from already-loaded PDF bytes. */
export async function parseSectionsFromPdf(bytes: Uint8Array): Promise<ParsedSections> {
  // pdfjs 4.x rejects a Node Buffer outright ("provide binary data as
  // `Uint8Array`, rather than `Buffer`"). Some callers hand us a Buffer
  // (it's a Uint8Array subclass, but pdfjs checks the constructor), so
  // normalize to a plain Uint8Array view before handing it over.
  const data = Buffer.isBuffer(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes;
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;
  try {
    const totalPages = doc.numPages;

    // Strategy 1 — bookmark outline.
    const outline = await doc.getOutline();
    let nodes: OutlineNode[] = [];
    if (outline && outline.length > 0) {
      for (const item of outline as RawOutlineItem[]) {
        const node = await toOutlineNode(doc, item);
        if (node) nodes.push(node);
      }
    }
    if (nodes.length > 0) {
      return { totalPages, sections: walkOutline(nodes, { totalPages }), strategy: 'outline' };
    }

    // Strategy 2 — header detection over page text.
    const pageTexts: string[] = [];
    for (let p = 1; p <= totalPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pageTexts.push(tc.items.map((it) => it.str ?? '').join(' '));
    }
    nodes = detectSectionsFromHeaders(pageTexts);
    if (nodes.length > 0) {
      return {
        totalPages,
        sections: walkOutline(nodes, { totalPages, fallbackConfidence: true }),
        strategy: 'headers',
      };
    }

    // Nothing detected — one catch-all section.
    return {
      totalPages,
      sections: walkOutline([{ title: 'Full return', startPage: 1 }], { totalPages }),
      strategy: 'single',
    };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

/** Load the source PDF from storage and parse it. */
export async function parseReturnSections(input: {
  storage: StorageClient;
  sourceStorageKey: string;
}): Promise<ParsedSections> {
  const { body } = await input.storage.get(input.sourceStorageKey);
  const bytes = new Uint8Array(await readAll(body));
  return parseSectionsFromPdf(bytes);
}

/**
 * Replace the return's sections with a freshly parsed set and flip the
 * return to PARSED. Runs in a transaction; the page-range-keyed release
 * flow doesn't depend on the parent hierarchy, so we flatten (depth is
 * retained for display indentation, parent_section_id stays null).
 */
export async function applyParsedSections(
  db: Database,
  returnId: string,
  parsed: ParsedSections,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(taxReturnSections).where(eq(taxReturnSections.returnId, returnId));
    for (const s of parsed.sections) {
      await tx.insert(taxReturnSections).values({
        returnId,
        ordinal: s.ordinal,
        depth: s.depth,
        rawTitle: s.rawTitle,
        normalizedTitle: s.normalizedTitle,
        kind: s.kind,
        formCode: s.formCode,
        recipientName: s.recipientName,
        startPage: s.startPage,
        endPage: s.endPage,
        releasable: s.releasable,
        parseConfidence: s.parseConfidence,
        isManualOverride: false,
      });
    }
    await tx
      .update(taxReturns)
      .set({
        status: 'PARSED',
        parsedAt: new Date(),
        totalPages: parsed.totalPages,
        updatedAt: new Date(),
      })
      .where(eq(taxReturns.id, returnId));
  });
  logger.info(
    { returnId, sections: parsed.sections.length, strategy: parsed.strategy },
    'tax-return sections parsed',
  );
}
