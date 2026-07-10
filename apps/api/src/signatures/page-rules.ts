// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Default signature page rules + idempotent seeding. A rule maps a bookmark
// pattern (per return type) to a signature page and the field layout placed
// on it. Firms tune these in admin; these defaults cover the common federal
// 8879 + state e-file authorizations + a bundled engagement letter.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { signaturePageRules } from '@vibe/db/schema';

export interface DefaultPageRule {
  formType: string;
  bookmarkPattern: string;
  matchMode: 'contains' | 'exact' | 'regex';
  layoutKey: string;
}

export const DEFAULT_SIGNATURE_PAGE_RULES: DefaultPageRule[] = [
  // Individual 1040 — federal 8879 (taxpayer + spouse).
  { formType: '1040', bookmarkPattern: '8879', matchMode: 'contains', layoutKey: 'us-8879' },
  {
    formType: '1040',
    bookmarkPattern: 'e-file Authorization',
    matchMode: 'contains',
    layoutKey: 'us-8879',
  },
  // Entity returns — 8879-S/C/PE (officer).
  { formType: '1120-S', bookmarkPattern: '8879', matchMode: 'contains', layoutKey: 'entity-8879' },
  { formType: '1120', bookmarkPattern: '8879', matchMode: 'contains', layoutKey: 'entity-8879' },
  { formType: '1065', bookmarkPattern: '8879', matchMode: 'contains', layoutKey: 'entity-8879' },
  // State e-file authorizations — any return type (included only if present).
  { formType: '*', bookmarkPattern: '8453', matchMode: 'contains', layoutKey: 'state-auth' },
  { formType: '*', bookmarkPattern: 'TR-579', matchMode: 'contains', layoutKey: 'state-auth' },
  {
    formType: '*',
    bookmarkPattern: 'e-file Signature Authorization',
    matchMode: 'contains',
    layoutKey: 'state-auth',
  },
  // A bundled engagement letter (generic taxpayer/spouse).
  {
    formType: '*',
    bookmarkPattern: 'Engagement Letter',
    matchMode: 'contains',
    layoutKey: 'generic',
  },
];

/** Seed the firm's default page rules if it has none yet. Returns the count
 *  inserted (0 when rules already exist). Idempotent. */
export async function seedDefaultSignaturePageRules(db: Database, firmId: string): Promise<number> {
  const existing = await db
    .select({ id: signaturePageRules.id })
    .from(signaturePageRules)
    .where(eq(signaturePageRules.firmId, firmId))
    .limit(1);
  if (existing.length > 0) return 0;
  await db.insert(signaturePageRules).values(
    DEFAULT_SIGNATURE_PAGE_RULES.map((r, i) => ({
      firmId,
      formType: r.formType,
      bookmarkPattern: r.bookmarkPattern,
      matchMode: r.matchMode,
      layoutKey: r.layoutKey,
      sortOrder: i,
    })),
  );
  return DEFAULT_SIGNATURE_PAGE_RULES.length;
}
