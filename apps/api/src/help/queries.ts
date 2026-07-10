// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Knowledge-base query helpers shared by the Help routes and the AI
// support chat (which retrieves articles to ground its answers).

import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { kbArticles, kbCategories } from '@vibe/db/schema';

/** Article visibility realm (0113). */
export type KbAudience = 'staff' | 'client' | 'both';
/** Audiences a client-portal request may see. */
export const PORTAL_AUDIENCES: KbAudience[] = ['client', 'both'];

// Very common words that add noise to a natural-language question.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'you',
  'your',
  'how',
  'can',
  'what',
  'with',
  'this',
  'that',
  'from',
  'are',
  'does',
  'where',
  'when',
  'who',
  'why',
  'into',
  'about',
  'have',
  'has',
  'should',
  'would',
  'could',
  'will',
  'our',
  'out',
  'use',
  'using',
  'get',
]);

function tokenize(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  // De-dupe, cap to keep the query bounded.
  return [...new Set(terms)].slice(0, 8);
}

export interface KbArticleHit {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  bodyMarkdown: string;
  categoryId: string | null;
}

// Case-insensitive substring search over PUBLISHED articles, title matches
// ranked first. Used for the KB search box and for chat retrieval. Returns
// [] for a blank query. When `audiences` is supplied (the client portal
// passes ['client','both']), results are restricted to those realms;
// omitting it keeps the staff-side behavior of searching all articles.
export async function searchKbArticles(
  db: Database | null,
  firmId: string,
  query: string,
  limit = 8,
  audiences?: KbAudience[],
): Promise<KbArticleHit[]> {
  if (!db) return [];
  const raw = query.trim();
  if (!raw) return [];
  // Tokenize so a natural-language question matches on its keywords rather
  // than requiring the whole phrase to appear verbatim.
  let terms = tokenize(raw);
  if (terms.length === 0) terms = [raw.toLowerCase()];

  const likes = terms.map((t) => `%${t.replace(/[%_\\]/g, '\\$&')}%`);
  const matchConds: SQL[] = [];
  const scoreParts: SQL[] = [];
  for (const like of likes) {
    matchConds.push(ilike(kbArticles.title, like));
    matchConds.push(ilike(kbArticles.summary, like));
    matchConds.push(ilike(kbArticles.bodyMarkdown, like));
    // Title hits weigh more than summary/body hits.
    scoreParts.push(
      sql`(CASE WHEN ${kbArticles.title} ILIKE ${like} THEN 3 ELSE 0 END) + (CASE WHEN ${kbArticles.summary} ILIKE ${like} THEN 2 ELSE 0 END) + (CASE WHEN ${kbArticles.bodyMarkdown} ILIKE ${like} THEN 1 ELSE 0 END)`,
    );
  }
  const score = sql.join(scoreParts, sql` + `);

  const rows = await db
    .select({
      id: kbArticles.id,
      slug: kbArticles.slug,
      title: kbArticles.title,
      summary: kbArticles.summary,
      bodyMarkdown: kbArticles.bodyMarkdown,
      categoryId: kbArticles.categoryId,
    })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.firmId, firmId),
        eq(kbArticles.status, 'PUBLISHED'),
        audiences && audiences.length ? inArray(kbArticles.audience, audiences) : undefined,
        or(...matchConds),
      ),
    )
    .orderBy(desc(sql`(${score})`), kbArticles.sortOrder)
    .limit(limit);
  return rows;
}

export interface KbCategorySummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  sortOrder: number;
  articleCount: number;
}

// Categories that have at least one PUBLISHED article visible to the given
// audiences, with the visible-article count. Used by the portal help center.
export async function listKbCategoriesForAudience(
  db: Database | null,
  firmId: string,
  audiences: KbAudience[],
): Promise<KbCategorySummary[]> {
  if (!db || !audiences.length) return [];
  const rows = await db
    .select({
      id: kbCategories.id,
      slug: kbCategories.slug,
      title: kbCategories.title,
      description: kbCategories.description,
      sortOrder: kbCategories.sortOrder,
      articleCount: sql<number>`count(${kbArticles.id})`,
    })
    .from(kbCategories)
    .innerJoin(
      kbArticles,
      and(
        eq(kbArticles.categoryId, kbCategories.id),
        eq(kbArticles.status, 'PUBLISHED'),
        inArray(kbArticles.audience, audiences),
      ),
    )
    .where(eq(kbCategories.firmId, firmId))
    .groupBy(kbCategories.id)
    .orderBy(asc(kbCategories.sortOrder), asc(kbCategories.title));
  return rows.map((r) => ({ ...r, articleCount: Number(r.articleCount) }));
}

export interface KbArticleSummary {
  slug: string;
  title: string;
  summary: string | null;
  categoryId: string | null;
}

// PUBLISHED article summaries visible to the given audiences, optionally
// filtered by category slug or a search query. No body (list view).
export async function listKbArticlesForAudience(
  db: Database | null,
  firmId: string,
  audiences: KbAudience[],
  opts: { categorySlug?: string; query?: string; limit?: number } = {},
): Promise<KbArticleSummary[]> {
  if (!db || !audiences.length) return [];
  // Delegate text search to the ranked searcher, then project to summaries.
  if (opts.query && opts.query.trim()) {
    const hits = await searchKbArticles(db, firmId, opts.query, opts.limit ?? 20, audiences);
    return hits.map((h) => ({
      slug: h.slug,
      title: h.title,
      summary: h.summary,
      categoryId: h.categoryId,
    }));
  }
  const conds: SQL[] = [
    eq(kbArticles.firmId, firmId),
    eq(kbArticles.status, 'PUBLISHED'),
    inArray(kbArticles.audience, audiences),
  ];
  if (opts.categorySlug) {
    const [cat] = await db
      .select({ id: kbCategories.id })
      .from(kbCategories)
      .where(and(eq(kbCategories.firmId, firmId), eq(kbCategories.slug, opts.categorySlug)))
      .limit(1);
    if (!cat) return [];
    conds.push(eq(kbArticles.categoryId, cat.id));
  }
  const rows = await db
    .select({
      slug: kbArticles.slug,
      title: kbArticles.title,
      summary: kbArticles.summary,
      categoryId: kbArticles.categoryId,
    })
    .from(kbArticles)
    .where(and(...conds))
    .orderBy(asc(kbArticles.sortOrder), asc(kbArticles.title))
    .limit(opts.limit ?? 100);
  return rows;
}

// A single PUBLISHED article by slug, only if visible to the audiences.
export async function getKbArticleForAudience(
  db: Database | null,
  firmId: string,
  slug: string,
  audiences: KbAudience[],
): Promise<KbArticleHit | null> {
  if (!db || !audiences.length) return null;
  const [row] = await db
    .select({
      id: kbArticles.id,
      slug: kbArticles.slug,
      title: kbArticles.title,
      summary: kbArticles.summary,
      bodyMarkdown: kbArticles.bodyMarkdown,
      categoryId: kbArticles.categoryId,
    })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.firmId, firmId),
        eq(kbArticles.slug, slug),
        eq(kbArticles.status, 'PUBLISHED'),
        inArray(kbArticles.audience, audiences),
      ),
    )
    .limit(1);
  return row ?? null;
}
