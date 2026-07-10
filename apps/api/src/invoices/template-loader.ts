// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Loads the firm's editable invoice document template into the
// InvoiceTemplateDef shape renderInvoiceDocument expects. When the firm
// has no saved row, this returns the shipped default letterhead template
// (NOT the legacy builtin) so every firm gets the new design by default.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { invoiceTemplates } from '@vibe/db/schema';
import {
  DEFAULT_INVOICE_BODY_HTML,
  DEFAULT_INVOICE_CSS,
  type InvoiceTemplateDef,
  type InvoiceTemplateStyle,
} from '@vibe/core/invoicing';

const BUILTIN_STYLES: InvoiceTemplateStyle[] = ['modern', 'classic', 'minimal'];

function asBuiltin(s: string | null | undefined): InvoiceTemplateStyle | null {
  return s && (BUILTIN_STYLES as string[]).includes(s) ? (s as InvoiceTemplateStyle) : null;
}

export async function loadInvoiceTemplateDef(
  db: Database,
  firmId: string,
): Promise<InvoiceTemplateDef> {
  const [row] = await db
    .select()
    .from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.firmId, firmId)))
    .limit(1);
  if (!row) {
    return { bodyHtml: DEFAULT_INVOICE_BODY_HTML, css: DEFAULT_INVOICE_CSS, builtinStyle: null };
  }
  const builtinStyle = asBuiltin(row.builtinStyle);
  return {
    bodyHtml: row.bodyHtml ?? DEFAULT_INVOICE_BODY_HTML,
    css: row.css ?? DEFAULT_INVOICE_CSS,
    builtinStyle,
  };
}
