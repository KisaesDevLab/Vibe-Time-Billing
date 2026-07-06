// SPDX-License-Identifier: Elastic-2.0
//
// Assembles a StatementTemplateInput from a RANDOM real client (one that
// has invoices) for the statement-template editor's live preview, so it
// reflects the firm's actual data. Returns null when the firm has no
// invoices (caller falls back to a built-in sample).

import { eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firms, invoices } from '@vibe/db/schema';
import type { StatementTemplateInput } from '@vibe/core/invoicing';

import { buildStatement, loadBranding } from './build';

export async function loadRandomStatementInput(
  db: Database,
  firmId: string,
): Promise<StatementTemplateInput | null> {
  const [row] = await db
    .select({ clientId: invoices.clientId })
    .from(invoices)
    .where(eq(invoices.firmId, firmId))
    .orderBy(sql`random()`)
    .limit(1);
  if (!row) return null;
  const [firmRow] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, firmId))
    .limit(1);
  const branding = await loadBranding(db, firmId);
  const asOf = new Date().toISOString().slice(0, 10);
  return buildStatement(db, firmId, row.clientId, asOf, branding, firmRow ?? null);
}
