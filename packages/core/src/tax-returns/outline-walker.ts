// SPDX-License-Identifier: Elastic-2.0
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

  // Step 2 — compute end_page for each.
  //
  // Tax-software outlines are NOT always page-monotonic in pre-order:
  // Drake/UltraTax-style exports carry a "Reports" wing whose items
  // (return summary, projection worksheets, state summaries) point at
  // pages interleaved with the Federal/State wings. Deriving end_page
  // from "the next bookmark in OUTLINE order" then swallows pages that
  // belong to other sections (e.g. a 1-page Return Summary claiming
  // 1–17 because its outline-neighbor starts at 18).
  //
  // Robust formulation, exact for monotonic outlines too:
  //   - a node's own range ends the page before the next page on which
  //     ANY section starts (strictly after its own start);
  //   - a parent additionally spans its descendants (pre-order means
  //     they're the contiguous run of deeper nodes right after it).
  const allStarts = [...new Set(flat.map((f) => f.node.startPage))].sort((a, b) => a - b);
  const nextStartAfter = (page: number): number | null => {
    for (const s of allStarts) if (s > page) return s;
    return null;
  };
  // Reverse order so every descendant's end is known before its parent.
  const endByIndex = new Array<number>(flat.length);
  for (let i = flat.length - 1; i >= 0; i--) {
    const cur = flat[i]!;
    const next = nextStartAfter(cur.node.startPage);
    let endPage = next != null ? next - 1 : opts.totalPages;
    for (let j = i + 1; j < flat.length && flat[j]!.depth > cur.depth; j++) {
      if (endByIndex[j]! > endPage) endPage = endByIndex[j]!;
    }
    if (endPage < cur.node.startPage) endPage = cur.node.startPage;
    endByIndex[i] = endPage;
  }

  const sections: FlatSection[] = [];
  for (let i = 0; i < flat.length; i++) {
    const cur = flat[i]!;
    const endPage = endByIndex[i]!;

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
