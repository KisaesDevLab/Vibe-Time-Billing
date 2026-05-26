// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-1 §3 — Outline → flat sections walker.
//
// The PDF library (pdfjs-dist in production, hand-built test fixture
// in tests) hands us an outline tree shaped as:
//
//   interface OutlineNode {
//     title: string;
//     startPage: number;       // 1-indexed
//     children?: OutlineNode[];
//   }
//
// We traverse it depth-first, assign `ordinal` in pre-order, derive
// `end_page` as the last page before the next sibling's start (or
// totalPages for the final leaf), and apply the normalization lexicon
// to each node.

import { type LexiconPattern, normalizeTitle } from './lexicon';

export interface OutlineNode {
  title: string;
  startPage: number;
  children?: OutlineNode[];
}

export interface FlatSection {
  ordinal: number;
  parentOrdinal: number | null;
  depth: number;
  rawTitle: string;
  normalizedTitle: string;
  kind:
    | 'COVER'
    | 'MAIN_FORM'
    | 'SCHEDULE'
    | 'K1'
    | 'STATE'
    | 'WORKSHEET'
    | 'ATTACHMENT'
    | 'UNKNOWN';
  formCode: string | null;
  recipientName: string | null;
  startPage: number;
  endPage: number;
  releasable: boolean;
  parseConfidence: number;
}

export interface WalkOptions {
  totalPages: number;
  lexicon?: LexiconPattern[];
  // If true, downgrade every section's parse_confidence to 60. Used
  // by the header-detection fallback caller (§3.2) which infers
  // sections from page-top regex matches rather than real bookmarks.
  fallbackConfidence?: boolean;
}

interface InProgress {
  node: OutlineNode;
  ordinal: number;
  parentOrdinal: number | null;
  depth: number;
}

export function walkOutline(roots: OutlineNode[], opts: WalkOptions): FlatSection[] {
  // Step 1 — pre-order traversal, assign ordinals.
  const flat: InProgress[] = [];
  let nextOrdinal = 0;
  function visit(node: OutlineNode, parentOrdinal: number | null, depth: number): void {
    const ordinal = nextOrdinal++;
    flat.push({ node, ordinal, parentOrdinal, depth });
    if (node.children) {
      for (const c of node.children) visit(c, ordinal, depth + 1);
    }
  }
  for (const r of roots) visit(r, null, 0);

  // Step 2 — compute end_page for each. A node's end_page is the
  // page BEFORE the next ordinal's start, except when the next
  // ordinal is a child (then the parent's range extends to where the
  // next sibling starts, not the child). Children inherit nothing —
  // they're computed independently.
  //
  // Simpler formulation: end_page = (next node at same-or-shallower
  // depth's startPage) - 1, falling back to totalPages.
  const sections: FlatSection[] = [];
  for (let i = 0; i < flat.length; i++) {
    const cur = flat[i]!;
    let endPage = opts.totalPages;
    for (let j = i + 1; j < flat.length; j++) {
      const candidate = flat[j]!;
      // Only siblings or shallower ancestors close us out. Deeper
      // descendants stay inside our range.
      if (candidate.depth <= cur.depth) {
        endPage = candidate.node.startPage - 1;
        break;
      }
    }
    if (endPage < cur.node.startPage) endPage = cur.node.startPage;

    const norm = normalizeTitle(cur.node.title, opts.lexicon);
    const confidence = opts.fallbackConfidence
      ? Math.min(norm.parseConfidence, 60)
      : norm.parseConfidence;
    sections.push({
      ordinal: cur.ordinal,
      parentOrdinal: cur.parentOrdinal,
      depth: cur.depth,
      rawTitle: cur.node.title,
      normalizedTitle: norm.normalizedTitle,
      kind: norm.kind,
      formCode: norm.formCode,
      recipientName: norm.recipientName,
      startPage: cur.node.startPage,
      endPage,
      releasable: norm.defaultReleasable,
      parseConfidence: confidence,
    });
  }
  return sections;
}
