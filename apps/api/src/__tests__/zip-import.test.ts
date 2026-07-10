// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0153 — Vibe Filer zip import: client match from the zip name, worker
// extraction preserving the zip's structure, skip-on-collision (never
// overwrite), zip-slip rejection, junk filtering, internal-only files.

import AdmZip from 'adm-zip';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { eq, sql } from 'drizzle-orm';

import type { StorageClient } from '@vibe/storage';
import { clientFolders, files, zipImports } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { matchClientByIdSubstring } from '../filer/scan';
import { runZipImport, safeEntryPath } from '../../../worker/src/jobs/zip-import';

const log = pino({ level: 'silent' });
let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

function fakeStorage(initial: Record<string, Buffer> = {}): {
  storage: StorageClient;
  objs: Map<string, Buffer>;
} {
  const objs = new Map<string, Buffer>(Object.entries(initial));
  const client = {
    kind: 'mock' as const,
    async head(k: string) {
      const b = objs.get(k);
      return b ? { key: k, sizeBytes: b.length, etag: 'e', lastModified: new Date() } : null;
    },
    async get(k: string) {
      const b = objs.get(k);
      if (!b) throw new Error(`missing object ${k}`);
      return {
        body: (async function* () {
          yield b;
        })(),
      };
    },
    async put(k: string, body: Buffer) {
      objs.set(k, Buffer.isBuffer(body) ? body : Buffer.from([]));
      return { etag: 'p' };
    },
    async delete(k: string) {
      objs.delete(k);
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function, require-yield
    async *list() {},
    async copy(_s: string, d: string) {
      return { etag: `c${d.length}` };
    },
  };
  return { storage: client as unknown as StorageClient, objs };
}

async function setup(): Promise<{ firmId: string; clientId: string; appUserId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  await harness.db.execute(sql`UPDATE client SET aws_id = 'GAMB1540' WHERE id = ${seed.clientId}`);
  await harness.db.insert(clientFolders).values({
    firmId: seed.firmId,
    clientId: seed.clientId,
    storagePath: 'Test Client Co/',
  });
  return seed;
}

function buildZip(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.addFile(path, Buffer.from(content));
  }
  return zip.toBuffer();
}

async function insertImport(
  f: { firmId: string; clientId: string; appUserId: string },
  zipBytes: Buffer,
  storage: StorageClient,
  destFolder = 'Payroll',
): Promise<string> {
  const importId = randomUUID();
  const zipKey = `Inbox/_imports/${importId}.zip`;
  await storage.put(zipKey, zipBytes, {});
  await harness.db.insert(zipImports).values({
    id: importId,
    firmId: f.firmId,
    zipName: 'cc20260612084954GAMB1540.zip',
    zipKey,
    zipSizeBytes: zipBytes.length,
    matchedClient: f.clientId,
    destFolder,
    status: 'queued',
    createdBy: f.appUserId,
  });
  return importId;
}

describe('safeEntryPath', () => {
  it('normalizes separators and strips leading slashes', () => {
    expect(safeEntryPath('Year 2025/Forms/a.pdf')).toBe('Year 2025/Forms/a.pdf');
    expect(safeEntryPath('\\windows\\style\\b.pdf')).toBe('windows/style/b.pdf');
    expect(safeEntryPath('/abs/c.pdf')).toBe('abs/c.pdf');
  });
  it('rejects traversal (zip-slip) and empty names', () => {
    expect(safeEntryPath('../../etc/passwd')).toBeNull();
    expect(safeEntryPath('ok/../../../evil.pdf')).toBeNull();
    expect(safeEntryPath('./sneaky.pdf')).toBeNull();
    expect(safeEntryPath('')).toBeNull();
  });
});

describe('matchClientByIdSubstring', () => {
  const clientsList = [
    { id: 'c1', name: 'Gamble LLC', externalId: null, awsId: 'GAMB1540', status: 'ACTIVE' },
    { id: 'c2', name: 'Acme', externalId: '123456', status: 'ACTIVE' },
  ];
  it('finds an id concatenated straight onto a timestamp', () => {
    const m = matchClientByIdSubstring('486aec2e-cc20260612084954GAMB1540', clientsList);
    expect(m?.clientId).toBe('c1');
    expect(m?.id).toBe('GAMB1540');
  });
  it('is case-insensitive', () => {
    expect(matchClientByIdSubstring('export_gamb1540_final', clientsList)?.clientId).toBe('c1');
  });
  it('ambiguous (two clients hit) → null', () => {
    expect(matchClientByIdSubstring('123456-GAMB1540', clientsList)).toBeNull();
  });
  it('no hit → null', () => {
    expect(matchClientByIdSubstring('nothing-here', clientsList)).toBeNull();
  });
});

describe('runZipImport', () => {
  it('extracts preserving structure, drops junk, internal-only files, deletes temp zip', async () => {
    const f = await setup();
    const { storage, objs } = fakeStorage();
    const zipBytes = buildZip({
      'Year 2025/Forms/2025_12_31_Forms_Filed.pdf': '%PDF-1',
      'Year 2025/Reports/2025-01-02 1 Payroll Set.pdf': '%PDF-2',
      'root-note.txt': 'hello',
      '__MACOSX/Year 2025/._junk': 'junk',
      'Year 2025/.DS_Store': 'junk',
    });
    const importId = await insertImport(f, zipBytes, storage);

    await runZipImport(harness.db, storage, log, {
      importId,
      firmId: f.firmId,
      actorId: f.appUserId,
    });

    const [row] = await harness.db.select().from(zipImports).where(eq(zipImports.id, importId));
    expect(row!.status).toBe('done');
    expect(row!.importedCount).toBe(3);
    expect(row!.skippedCount).toBe(0);
    expect(row!.errorCount).toBe(0);

    expect(objs.has('Test Client Co/Payroll/Year 2025/Forms/2025_12_31_Forms_Filed.pdf')).toBe(
      true,
    );
    expect(objs.has('Test Client Co/Payroll/Year 2025/Reports/2025-01-02 1 Payroll Set.pdf')).toBe(
      true,
    );
    expect(objs.has('Test Client Co/Payroll/root-note.txt')).toBe(true);
    // Junk never lands, temp zip removed.
    expect([...objs.keys()].some((k) => k.includes('_MACOSX') || k.includes('.DS_Store'))).toBe(
      false,
    );
    expect([...objs.keys()].some((k) => k.startsWith('Inbox/_imports/'))).toBe(false);

    const fileRows = await harness.db.select().from(files).where(eq(files.firmId, f.firmId));
    expect(fileRows).toHaveLength(3);
    expect(fileRows.every((r) => r.visibility === 'private')).toBe(true);
    expect(fileRows.every((r) => r.source === 'zip_import')).toBe(true);
    const pdf = fileRows.find((r) => r.originalFilename === '2025_12_31_Forms_Filed.pdf');
    expect(pdf!.subfolderPath).toBe('Payroll/Year 2025/Forms/');
    expect(pdf!.mimeType).toBe('application/pdf');
  });

  it('never overwrites — same-name file is skipped and reported', async () => {
    const f = await setup();
    const existingKey = 'Test Client Co/Payroll/Year 2025/Forms/a.pdf';
    const { storage, objs } = fakeStorage({ [existingKey]: Buffer.from('ORIGINAL') });
    const zipBytes = buildZip({
      'Year 2025/Forms/a.pdf': 'NEW CONTENT',
      'Year 2025/Forms/b.pdf': '%PDF-b',
    });
    const importId = await insertImport(f, zipBytes, storage);

    await runZipImport(harness.db, storage, log, {
      importId,
      firmId: f.firmId,
      actorId: f.appUserId,
    });

    const [row] = await harness.db.select().from(zipImports).where(eq(zipImports.id, importId));
    expect(row!.status).toBe('done');
    expect(row!.importedCount).toBe(1);
    expect(row!.skippedCount).toBe(1);
    expect(objs.get(existingKey)!.toString()).toBe('ORIGINAL'); // untouched
    const skippedEntry = row!.results!.find((r) => r.path === 'Year 2025/Forms/a.pdf');
    expect(skippedEntry?.status).toBe('skipped');
  });

  it('rejects blocked types without failing the import', async () => {
    // (Traversal names can't even be authored with adm-zip — it
    // normalizes them at creation. The zip-slip guard against zips from
    // other tools is unit-tested via safeEntryPath above.)
    const f = await setup();
    const { storage, objs } = fakeStorage();
    const zip = new AdmZip();
    zip.addFile('good.pdf', Buffer.from('%PDF'));
    zip.addFile('evil.exe', Buffer.from('MZ'));
    const importId = await insertImport(f, zip.toBuffer(), storage, '');

    await runZipImport(harness.db, storage, log, {
      importId,
      firmId: f.firmId,
      actorId: f.appUserId,
    });

    const [row] = await harness.db.select().from(zipImports).where(eq(zipImports.id, importId));
    expect(row!.status).toBe('done');
    expect(row!.importedCount).toBe(1);
    expect(row!.errorCount).toBe(1);
    expect(objs.has('Test Client Co/good.pdf')).toBe(true);
    expect([...objs.keys()].some((k) => k.includes('.exe'))).toBe(false);
  });
});
