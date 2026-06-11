// SPDX-License-Identifier: Elastic-2.0
//
// Folder-structure templates: default seed, per-client resolution, and the
// assignment override. The Explorer renders resolveClientFolders() as the
// virtual skeleton under each client root.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { clientFolderTemplateItems, clientFolderTemplates, clients } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  DEFAULT_FOLDER_TEMPLATE,
  resolveClientFolders,
  seedDefaultFolderTemplate,
} from '../clients/folder-templates';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('folder templates', () => {
  it('seeds the Standard default once (idempotent)', async () => {
    const a = await seedDefaultFolderTemplate(harness.db, seed.firmId);
    const b = await seedDefaultFolderTemplate(harness.db, seed.firmId);
    expect(a).toBe(b);
    const tmpls = await harness.db
      .select()
      .from(clientFolderTemplates)
      .where(eq(clientFolderTemplates.firmId, seed.firmId));
    expect(tmpls).toHaveLength(1);
    expect(tmpls[0]!.isDefault).toBe(true);
  });

  it('resolves the firm default skeleton (in order) for an unassigned client', async () => {
    const folders = await resolveClientFolders(harness.db, seed.firmId, seed.clientId);
    expect(folders.map((f) => f.name)).toEqual(DEFAULT_FOLDER_TEMPLATE.items.map((i) => i.name));
    expect(folders.find((f) => f.name === 'Client Uploads')!.visibility).toBe('client_visible');
  });

  it('honors a per-client template assignment over the default', async () => {
    await seedDefaultFolderTemplate(harness.db, seed.firmId);
    const [custom] = await harness.db
      .insert(clientFolderTemplates)
      .values({ firmId: seed.firmId, name: 'Business', isDefault: false })
      .returning({ id: clientFolderTemplates.id });
    await harness.db.insert(clientFolderTemplateItems).values([
      { templateId: custom!.id, name: 'Bookkeeping', sortOrder: 0 },
      { templateId: custom!.id, name: 'Payroll', sortOrder: 1, enabled: false },
    ]);
    await harness.db
      .update(clients)
      .set({ folderTemplateId: custom!.id })
      .where(eq(clients.id, seed.clientId));

    const folders = await resolveClientFolders(harness.db, seed.firmId, seed.clientId);
    // disabled item dropped; only the enabled one remains
    expect(folders.map((f) => f.name)).toEqual(['Bookkeeping']);
  });
});
