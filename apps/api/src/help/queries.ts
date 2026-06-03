// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Knowledge-base query helpers shared by the Help routes and the AI
// support chat (which retrieves articles to ground its answers).

import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { kbArticles } from '@vibe/db/schema';

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
// [] for a blank query.
export async function searchKbArticles(
  db: Database | null,
  firmId: string,
  query: string,
  limit = 8,
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
      and(eq(kbArticles.firmId, firmId), eq(kbArticles.status, 'PUBLISHED'), or(...matchConds)),
    )
    .orderBy(desc(sql`(${score})`), kbArticles.sortOrder)
    .limit(limit);
  return rows;
}
