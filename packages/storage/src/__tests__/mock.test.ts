// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockStorageClient, parseMockPresignUrl } from '../mock';

describe('MockStorageClient', () => {
  let root: string;
  let client: MockStorageClient;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vibe-storage-mock-'));
    client = new MockStorageClient({ rootPath: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips put → head → get', async () => {
    const body = Buffer.from('hello world', 'utf8');
    const { etag } = await client.put('Smith/Invoices/inv.pdf', body);
    expect(etag).toMatch(/^[0-9a-f]{64}$/);

    const meta = await client.head('Smith/Invoices/inv.pdf');
    expect(meta).not.toBeNull();
    expect(meta!.sizeBytes).toBe(11);
    expect(meta!.etag).toBe(etag);

    const { body: readBody, meta: readMeta } = await client.get('Smith/Invoices/inv.pdf');
    expect(readMeta.etag).toBe(etag);
    const chunks: Buffer[] = [];
    for await (const chunk of readBody) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello world');
  });

  it('returns null head for missing keys', async () => {
    expect(await client.head('does/not/exist.pdf')).toBeNull();
  });

  it('throws on get of missing keys', async () => {
    await expect(client.get('does/not/exist.pdf')).rejects.toThrow(/not found/);
  });

  it('delete is idempotent', async () => {
    await client.put('a/b.txt', Buffer.from('hi'));
    await client.delete('a/b.txt');
    await client.delete('a/b.txt'); // second delete must not throw
    expect(await client.head('a/b.txt')).toBeNull();
  });

  it('copy creates a new etag with the same bytes', async () => {
    const body = Buffer.from('payload', 'utf8');
    const { etag: srcEtag } = await client.put('src/file.txt', body);
    const { etag: copyEtag } = await client.copy('src/file.txt', 'dest/file.txt');
    // Both rows hashed the same bytes; etags match.
    expect(copyEtag).toBe(srcEtag);
    const destMeta = await client.head('dest/file.txt');
    expect(destMeta!.sizeBytes).toBe(7);
  });

  it('accepts a Readable body for put', async () => {
    const stream = Readable.from(['part1 ', 'part2']);
    const { etag } = await client.put('stream/file.txt', stream);
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    const meta = await client.head('stream/file.txt');
    expect(meta!.sizeBytes).toBe(11);
  });

  it('lists objects + common prefixes with delimiter', async () => {
    await client.put('Smith/inv.pdf', Buffer.from('a'));
    await client.put('Smith/receipt.pdf', Buffer.from('b'));
    await client.put('Smith/Invoices/2024.pdf', Buffer.from('c'));
    const results: { kind: string; key: string }[] = [];
    for await (const item of client.list('Smith/')) {
      results.push({ kind: item.kind, key: item.key });
    }
    // Expect 2 files + 1 prefix.
    const prefixes = results.filter((r) => r.kind === 'prefix').map((r) => r.key);
    const objects = results.filter((r) => r.kind === 'object').map((r) => r.key);
    expect(prefixes).toEqual(['Smith/Invoices/']);
    expect(objects.sort()).toEqual(['Smith/inv.pdf', 'Smith/receipt.pdf']);
  });

  it('lists an empty prefix as empty iterable (no throw)', async () => {
    const results: unknown[] = [];
    for await (const item of client.list('does/not/exist/')) results.push(item);
    expect(results).toEqual([]);
  });

  it('refuses traversal via ..', async () => {
    await expect(client.put('../escape', Buffer.from('x'))).rejects.toThrow();
  });

  it('builds and parses mock-presign URLs', async () => {
    const url = await client.presignGet('Smith/inv.pdf', 60);
    expect(url).toMatch(/^mock-presign:\/\/get\//);
    const parsed = parseMockPresignUrl(url);
    expect(parsed?.kind).toBe('get');
    expect(parsed?.key).toBe('Smith/inv.pdf');
    expect(parsed?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('presignPut URLs are kind=put', async () => {
    const url = await client.presignPut('Smith/inv.pdf', {}, 60);
    const parsed = parseMockPresignUrl(url);
    expect(parsed?.kind).toBe('put');
  });

  it('parses returns null on bogus URLs', () => {
    expect(parseMockPresignUrl('https://example.com/foo')).toBeNull();
  });
});
