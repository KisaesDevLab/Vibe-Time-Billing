// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-2 — Page-range subset extraction planning.
//
// The actual PDF extraction lives behind pdf-lib (installed by ops at
// the perimeter). This module owns the planning surface — the bits
// that affect cache correctness, watermark consistency, and audit
// determinism. Everything here is pure.
//
// Plan inputs: a release/share scope (FULL or SELECTED + section_ids),
// the section catalog for the return, and a watermark context. Plan
// output: an ordered, deduplicated list of 1-indexed page numbers; a
// canonical watermark string; and a SHA-256 cache key spanning all of
// the above.

import { createHash } from 'node:crypto';

export interface SectionPageRange {
  id: string;
  ordinal: number;
  startPage: number;
  endPage: number;
}

export type WatermarkAudience = 'CLIENT' | 'STAFF_IMPERSONATION' | 'RECIPIENT';

export interface WatermarkContext {
  audience: WatermarkAudience;
  // Pre-formatted ISO timestamp — caller passes; helper just embeds.
  timestamp: string;
  // CLIENT: client_name. STAFF_IMPERSONATION: staff_name. RECIPIENT:
  // recipient_email.
  primary: string;
  // Optional second line. STAFF_IMPERSONATION: client_name being
  // viewed. RECIPIENT: organization.
  secondary?: string;
}

export interface ExtractPlan {
  pageIndices1Based: number[];
  watermarkText: string;
  // Deterministic key for caching the rendered PDF bytes. Includes
  // every input that changes the output.
  cacheKey: string;
}

export interface PlanInputs {
  returnId: string;
  scope: 'FULL' | 'SELECTED';
  // When scope='SELECTED', these are the section IDs the caller is
  // allowed to see. They must be a subset of `sectionCatalog`.
  sectionIds: string[];
  // The return's full section list (in ordinal order).
  sectionCatalog: SectionPageRange[];
  totalPages: number;
  watermark: WatermarkContext;
  // The release_id or share_id this extraction is anchored to. Mixed
  // into the cache key so the same page-set rendered for two distinct
  // releases gets distinct cache entries (useful when watermarks
  // differ per release — e.g. one client gets "downloadable", another
  // doesn't).
  anchorId: string;
}

export class ExtractPlanError extends Error {
  constructor(
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ExtractPlanError';
  }
}

function expandRange(start: number, end: number): number[] {
  const out: number[] = [];
  for (let p = start; p <= end; p++) out.push(p);
  return out;
}

function formatWatermark(ctx: WatermarkContext): string {
  const parts: string[] = [];
  switch (ctx.audience) {
    case 'CLIENT':
      // "{client_name} · viewed {timestamp}"
      parts.push(ctx.primary, `viewed ${ctx.timestamp}`);
      break;
    case 'STAFF_IMPERSONATION':
      // "VIEW AS CLIENT · {staff_name} · {client_name} · {timestamp}"
      parts.push('VIEW AS CLIENT', ctx.primary);
      if (ctx.secondary) parts.push(ctx.secondary);
      parts.push(ctx.timestamp);
      break;
    case 'RECIPIENT':
      // "{recipient_email} · {org} · viewed {timestamp}"
      parts.push(ctx.primary);
      if (ctx.secondary) parts.push(ctx.secondary);
      parts.push(`viewed ${ctx.timestamp}`);
      break;
  }
  return parts.filter((p) => p.length > 0).join(' · ');
}

function canonicalWatermarkPayload(ctx: WatermarkContext): string {
  // Canonical form used in cache key — JSON-stable. The display
  // string is for stamping; the canonical form is for hashing.
  return JSON.stringify({
    audience: ctx.audience,
    primary: ctx.primary,
    secondary: ctx.secondary ?? '',
    timestamp: ctx.timestamp,
  });
}

export function planExtraction(input: PlanInputs): ExtractPlan {
  const catalogById = new Map(input.sectionCatalog.map((s) => [s.id, s]));

  // Resolve section ID list → ordered union of page ranges.
  let pages: number[];
  if (input.scope === 'FULL') {
    if (input.sectionIds.length > 0) {
      throw new ExtractPlanError(
        'full_scope_with_section_ids',
        'FULL scope must have an empty sectionIds array',
      );
    }
    pages = expandRange(1, input.totalPages);
  } else {
    if (input.sectionIds.length === 0) {
      throw new ExtractPlanError(
        'selected_scope_empty',
        'SELECTED scope requires at least one section_id',
      );
    }
    // Validate every requested section is in the catalog and stamp
    // them with the catalog ordinal so we can sort.
    const orderedSections: SectionPageRange[] = [];
    for (const id of input.sectionIds) {
      const found = catalogById.get(id);
      if (!found) {
        throw new ExtractPlanError('unknown_section', `section_id ${id} not in catalog`);
      }
      orderedSections.push(found);
    }
    orderedSections.sort((a, b) => a.ordinal - b.ordinal);
    // Expand + deduplicate. A page that's covered by two overlapping
    // sections (e.g. a parent + its child) only appears once.
    const seen = new Set<number>();
    pages = [];
    for (const s of orderedSections) {
      for (let p = s.startPage; p <= s.endPage; p++) {
        if (p < 1 || p > input.totalPages) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        pages.push(p);
      }
    }
  }

  if (pages.length === 0) {
    throw new ExtractPlanError('no_pages_in_plan', 'extraction plan resolved to zero pages');
  }

  const watermarkText = formatWatermark(input.watermark);

  // Cache key: hash returnId + anchorId + sorted page ordinals +
  // canonical watermark payload.
  const sortedPages = [...pages].sort((a, b) => a - b);
  const canonicalKey = JSON.stringify({
    returnId: input.returnId,
    anchorId: input.anchorId,
    pages: sortedPages,
    watermark: canonicalWatermarkPayload(input.watermark),
  });
  const cacheKey = createHash('sha256').update(canonicalKey).digest('hex');

  return {
    pageIndices1Based: pages,
    watermarkText,
    cacheKey,
  };
}
