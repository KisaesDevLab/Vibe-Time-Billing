// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client folder-structure templates. Templates are a firm-level definition;
// they're applied as a *virtual* skeleton — the Explorer unions a client's
// resolved template folders with the file-derived ones, so the structure
// shows under every client root even when empty. A client may be assigned a
// specific template via client.folder_template_id; otherwise the firm default
// applies. No per-client folder rows or B2 markers are created.

import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientFolderTemplateItems, clientFolderTemplates, clients } from '@vibe/db/schema';

// The starter template seeded for every firm. Visibility is a display hint +
// (where set) the default applied to files filed into that folder.
export const DEFAULT_FOLDER_TEMPLATE = {
  name: 'Standard',
  items: [
    { name: 'Correspondence', visibility: null },
    { name: 'Income Tax', visibility: null },
    { name: 'Other', visibility: null },
    { name: 'Payroll', visibility: null },
    { name: 'Permanent', visibility: null },
    { name: 'Workpapers & Support', visibility: null },
    { name: 'Signatures', visibility: null },
    { name: 'Client Uploads', visibility: 'client_visible' as const },
  ] as Array<{ name: string; visibility: 'private' | 'client_visible' | null }>,
};

/** Seed the firm's default template if it has none. Idempotent. Returns the
 *  default template id (existing or freshly seeded), or null if db is absent. */
export async function seedDefaultFolderTemplate(
  db: Database,
  firmId: string,
): Promise<string | null> {
  const [existing] = await db
    .select({ id: clientFolderTemplates.id })
    .from(clientFolderTemplates)
    .where(and(eq(clientFolderTemplates.firmId, firmId), eq(clientFolderTemplates.isDefault, true)))
    .limit(1);
  if (existing) return existing.id;

  const [tmpl] = await db
    .insert(clientFolderTemplates)
    .values({ firmId, name: DEFAULT_FOLDER_TEMPLATE.name, isDefault: true })
    .returning({ id: clientFolderTemplates.id });
  if (!tmpl) return null;
  await db.insert(clientFolderTemplateItems).values(
    DEFAULT_FOLDER_TEMPLATE.items.map((it, i) => ({
      templateId: tmpl.id,
      name: it.name,
      visibility: it.visibility,
      sortOrder: i,
    })),
  );
  return tmpl.id;
}

export interface ResolvedFolder {
  name: string;
  visibility: 'private' | 'client_visible' | null;
}

/**
 * Resolve the ordered folder skeleton that applies to a client: its assigned
 * template, else the firm default (seeded on demand). Returns enabled items
 * only. Used by the Explorer to render the virtual folders.
 */
export async function resolveClientFolders(
  db: Database,
  firmId: string,
  clientId: string,
): Promise<ResolvedFolder[]> {
  const [client] = await db
    .select({ folderTemplateId: clients.folderTemplateId })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);

  let templateId = client?.folderTemplateId ?? null;
  if (templateId) {
    // Guard against an assignment pointing at another firm's / deleted template.
    const [ok] = await db
      .select({ id: clientFolderTemplates.id })
      .from(clientFolderTemplates)
      .where(
        and(eq(clientFolderTemplates.id, templateId), eq(clientFolderTemplates.firmId, firmId)),
      )
      .limit(1);
    if (!ok) templateId = null;
  }
  if (!templateId) templateId = await seedDefaultFolderTemplate(db, firmId);
  if (!templateId) return [];

  const items = await db
    .select({
      name: clientFolderTemplateItems.name,
      visibility: clientFolderTemplateItems.visibility,
    })
    .from(clientFolderTemplateItems)
    .where(
      and(
        eq(clientFolderTemplateItems.templateId, templateId),
        eq(clientFolderTemplateItems.enabled, true),
      ),
    )
    .orderBy(asc(clientFolderTemplateItems.sortOrder));
  return items.map((i) => ({
    name: i.name,
    visibility: i.visibility as ResolvedFolder['visibility'],
  }));
}
