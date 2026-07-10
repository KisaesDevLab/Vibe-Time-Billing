// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Loads the firm's editable statement template (mirrors the invoice
// template loader). No saved row → shipped default statement template,
// so every firm gets the new design by default.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { statementTemplates } from '@vibe/db/schema';
import {
  DEFAULT_STATEMENT_BODY_HTML,
  DEFAULT_STATEMENT_CSS,
  type StatementTemplateDef,
} from '@vibe/core/invoicing';

export async function loadStatementTemplateDef(
  db: Database,
  firmId: string,
): Promise<StatementTemplateDef> {
  const [row] = await db
    .select()
    .from(statementTemplates)
    .where(eq(statementTemplates.firmId, firmId))
    .limit(1);
  if (!row) {
    return {
      bodyHtml: DEFAULT_STATEMENT_BODY_HTML,
      css: DEFAULT_STATEMENT_CSS,
      builtinStyle: null,
    };
  }
  return {
    bodyHtml: row.bodyHtml ?? DEFAULT_STATEMENT_BODY_HTML,
    css: row.css ?? DEFAULT_STATEMENT_CSS,
    builtinStyle: row.builtinStyle ?? null,
  };
}
