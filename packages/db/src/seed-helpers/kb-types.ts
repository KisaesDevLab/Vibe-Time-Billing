// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared types + helper for the knowledge-base seed content. Kept in their own
// module so the per-area article files (kb-gap-*.ts) can import them without
// forming an import cycle with knowledge-base.ts, which aggregates those files.

export interface ArticleDef {
  slug: string;
  category: string;
  title: string;
  summary: string;
  tags: string[];
  sortOrder: number;
  body: string;
  // 0113 — realm visibility. Omitted = 'staff' (internal). Client-facing
  // articles are tagged 'both' so they appear in the portal help center +
  // ground the portal AI support chat, and staff can still see them.
  audience?: 'staff' | 'client' | 'both';
}

export const md = (s: string): string => s.trim();
