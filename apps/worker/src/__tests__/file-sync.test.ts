// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Unit tests for the file-level diff planner (Phase 5).

import { describe, expect, it } from 'vitest';

import {
  classifyObservedKey,
  decideFileSyncPlan,
  type ExistingFileRow,
  type ObservedFile,
} from '../jobs/storage-sync';

const ROOT = 'Smith, John & Mary/';
const SENTINEL_FOLDER = '_Vibe';

function obs(storageKey: string, overrides: Partial<ObservedFile> = {}): ObservedFile {
  return {
    storageKey,
    sizeBytes: 1024,
    etag: 'etag-default',
    lastModified: new Date('2026-05-22T00:00:00Z'),
    ...overrides,
  };
}

function row(storageKey: string, overrides: Partial<ExistingFileRow> = {}): ExistingFileRow {
  return {
    id: `row-${storageKey}`,
    storageKey,
    etag: 'etag-default',
    sizeBytes: 1024,
    deletedAt: null,
    pendingUpload: false,
    ...overrides,
  };
}

describe('classifyObservedKey', () => {
  it('extracts subfolder + filename for nested keys', () => {
    expect(classifyObservedKey(`${ROOT}Invoices/2024/inv.pdf`, ROOT, SENTINEL_FOLDER)).toEqual({
      subfolderPath: 'Invoices/2024/',
      filename: 'inv.pdf',
    });
  });

  it('uses empty subfolder for top-level files', () => {
    expect(classifyObservedKey(`${ROOT}readme.txt`, ROOT, SENTINEL_FOLDER)).toEqual({
      subfolderPath: '',
      filename: 'readme.txt',
    });
  });

  it('returns null for the sentinel file itself', () => {
    expect(classifyObservedKey(`${ROOT}_Vibe/client.json`, ROOT, SENTINEL_FOLDER)).toBeNull();
  });

  it('returns null for anything nested in the sentinel subtree', () => {
    expect(classifyObservedKey(`${ROOT}_Vibe/x/y.bin`, ROOT, SENTINEL_FOLDER)).toBeNull();
  });

  it('returns null for keys not under the folder root', () => {
    expect(classifyObservedKey('Other/file.pdf', ROOT, SENTINEL_FOLDER)).toBeNull();
  });

  it('returns null for the folder root marker itself', () => {
    expect(classifyObservedKey(ROOT, ROOT, SENTINEL_FOLDER)).toBeNull();
  });
});

describe('decideFileSyncPlan — inserts', () => {
  it('inserts new objects with derived subfolder + filename', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [obs(`${ROOT}Invoices/inv1.pdf`, { etag: 'e1', sizeBytes: 500 })],
      existing: [],
    });
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      storageKey: `${ROOT}Invoices/inv1.pdf`,
      subfolderPath: 'Invoices/',
      originalFilename: 'inv1.pdf',
      sizeBytes: 500,
      etag: 'e1',
      visibility: 'private',
      source: 'explorer',
    });
  });

  it('skips sentinel files entirely', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [obs(`${ROOT}_Vibe/client.json`)],
      existing: [],
    });
    expect(plan.inserts).toHaveLength(0);
  });
});

describe('decideFileSyncPlan — updates', () => {
  it('updates rows when etag changed', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [obs(`${ROOT}readme.txt`, { etag: 'e2', sizeBytes: 2048 })],
      existing: [row(`${ROOT}readme.txt`, { etag: 'e1', sizeBytes: 1024 })],
    });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({
      rowId: `row-${ROOT}readme.txt`,
      etag: 'e2',
      sizeBytes: 2048,
    });
    expect(plan.inserts).toHaveLength(0);
  });

  it('no-ops when etag + size match', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [obs(`${ROOT}readme.txt`, { etag: 'e1', sizeBytes: 1024 })],
      existing: [row(`${ROOT}readme.txt`, { etag: 'e1', sizeBytes: 1024 })],
    });
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.softDeletes).toHaveLength(0);
    expect(plan.undeletes).toHaveLength(0);
  });
});

describe('decideFileSyncPlan — soft deletes', () => {
  it('soft-deletes rows whose key was not observed', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [],
      existing: [row(`${ROOT}readme.txt`)],
    });
    expect(plan.softDeletes).toHaveLength(1);
    expect(plan.softDeletes[0]).toMatchObject({ rowId: `row-${ROOT}readme.txt` });
  });

  it('does not re-soft-delete already-deleted rows', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [],
      existing: [row(`${ROOT}readme.txt`, { deletedAt: new Date() })],
    });
    expect(plan.softDeletes).toHaveLength(0);
  });

  it('does not soft-delete pending_upload rows the API has reserved', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [],
      existing: [row(`${ROOT}pending.pdf`, { pendingUpload: true })],
    });
    expect(plan.softDeletes).toHaveLength(0);
  });
});

describe('decideFileSyncPlan — undeletes', () => {
  it('undeletes a row when its key reappears', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [obs(`${ROOT}readme.txt`, { etag: 'e2', sizeBytes: 4096 })],
      existing: [row(`${ROOT}readme.txt`, { deletedAt: new Date(), etag: 'e1', sizeBytes: 1024 })],
    });
    expect(plan.undeletes).toHaveLength(1);
    expect(plan.undeletes[0]).toMatchObject({
      rowId: `row-${ROOT}readme.txt`,
      etag: 'e2',
      sizeBytes: 4096,
    });
    expect(plan.updates).toHaveLength(0);
  });
});

describe('decideFileSyncPlan — pending_upload protection', () => {
  it('ignores pending_upload rows even when observed (they belong to the API)', () => {
    const plan = decideFileSyncPlan({
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [obs(`${ROOT}reserved.bin`, { etag: 'real-etag', sizeBytes: 99 })],
      existing: [row(`${ROOT}reserved.bin`, { pendingUpload: true, etag: null, sizeBytes: 0 })],
    });
    expect(plan.updates).toHaveLength(0);
    expect(plan.inserts).toHaveLength(0);
  });
});

describe('decideFileSyncPlan — idempotency', () => {
  it('produces an empty plan when storage and DB are in sync', () => {
    const input = {
      folderRoot: ROOT,
      sentinelFolder: SENTINEL_FOLDER,
      observed: [
        obs(`${ROOT}readme.txt`, { etag: 'e1', sizeBytes: 1024 }),
        obs(`${ROOT}Invoices/inv.pdf`, { etag: 'e2', sizeBytes: 2048 }),
      ],
      existing: [
        row(`${ROOT}readme.txt`, { etag: 'e1', sizeBytes: 1024 }),
        row(`${ROOT}Invoices/inv.pdf`, { etag: 'e2', sizeBytes: 2048 }),
      ],
    };
    const first = decideFileSyncPlan(input);
    const second = decideFileSyncPlan(input);
    expect(first).toEqual({ inserts: [], updates: [], softDeletes: [], undeletes: [] });
    expect(second).toEqual({ inserts: [], updates: [], softDeletes: [], undeletes: [] });
  });
});
