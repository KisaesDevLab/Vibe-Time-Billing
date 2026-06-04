// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Real-B2 integration suite. Skipped unless `B2_INTEGRATION=1` and
// all B2_* env vars are present. The test bucket should be a
// throwaway — every test puts then deletes the objects it creates,
// but a failed run can leave stragglers.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { B2StorageClient } from '../b2';

const B2_ENABLED =
  process.env['B2_INTEGRATION'] === '1' &&
  Boolean(process.env['B2_ENDPOINT']) &&
  Boolean(process.env['B2_REGION']) &&
  Boolean(process.env['B2_BUCKET']) &&
  Boolean(process.env['B2_KEY_ID']) &&
  Boolean(process.env['B2_APPLICATION_KEY']);

describe.skipIf(!B2_ENABLED)('B2StorageClient — integration', () => {
  const client = new B2StorageClient({
    endpoint: process.env['B2_ENDPOINT']!,
    region: process.env['B2_REGION']!,
    bucket: process.env['B2_BUCKET']!,
    accessKeyId: process.env['B2_KEY_ID']!,
    secretAccessKey: process.env['B2_APPLICATION_KEY']!,
  });
  const prefix = `__test/${Date.now()}__/`;

  it('round-trips put → head → get → delete', async () => {
    const key = `${prefix}round-trip.txt`;
    const body = Buffer.from('hello b2', 'utf8');
    const { etag } = await client.put(key, body, { contentType: 'text/plain' });
    expect(etag).toBeTruthy();

    const meta = await client.head(key);
    expect(meta).not.toBeNull();
    expect(meta!.sizeBytes).toBe(8);

    const got = await client.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of got.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello b2');

    await client.delete(key);
    expect(await client.head(key)).toBeNull();
  });

  it('copy creates a new object', async () => {
    const src = `${prefix}copy-src.txt`;
    const dest = `${prefix}copy-dest.txt`;
    await client.put(src, Buffer.from('xxx'));
    await client.copy(src, dest);
    expect(await client.head(dest)).not.toBeNull();
    await client.delete(src);
    await client.delete(dest);
  });

  it('list yields uploaded objects', async () => {
    const a = `${prefix}list-a.txt`;
    const b = `${prefix}list-b.txt`;
    await client.put(a, Buffer.from('1'));
    await client.put(b, Buffer.from('2'));
    const keys: string[] = [];
    for await (const item of client.list(prefix)) {
      if (item.kind === 'object') keys.push(item.key);
    }
    expect(keys.sort()).toEqual([a, b].sort());
    await client.delete(a);
    await client.delete(b);
  });

  it('accepts a Readable body for put', async () => {
    const key = `${prefix}stream.txt`;
    const stream = Readable.from(['s1', 's2']);
    await client.put(key, stream);
    const meta = await client.head(key);
    expect(meta?.sizeBytes).toBe(4);
    await client.delete(key);
  });

  it('presignGet returns an https URL', async () => {
    const key = `${prefix}presign.txt`;
    await client.put(key, Buffer.from('hi'));
    const url = await client.presignGet(key, 60);
    expect(url).toMatch(/^https:\/\//);
    await client.delete(key);
  });

  it('presignGet URL actually downloads the object bytes over HTTP', async () => {
    const key = `${prefix}presign-get.txt`;
    await client.put(key, Buffer.from('download me', 'utf8'), { contentType: 'text/plain' });
    const url = await client.presignGet(key, 60);
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('download me');
    await client.delete(key);
  });

  // The presignPut SigV4 header logic (conditional ContentType/ContentLength)
  // is the documented source of B2 403 SignatureDoesNotMatch — exercise a
  // real PUT over the wire with the presigned URL, then read it back.
  it('presignPut URL accepts a real HTTP PUT with a signed content-type', async () => {
    const key = `${prefix}presign-put-typed.txt`;
    const url = await client.presignPut(key, { contentType: 'text/plain' }, 60);
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'uploaded via presigned put',
    });
    expect(resp.status).toBe(200);
    const got = await client.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of got.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('uploaded via presigned put');
    await client.delete(key);
  });

  it('presignPut URL accepts a PUT when no content-type was signed', async () => {
    // Browser-unknown-MIME path: the client omits ContentType from the
    // signature so the browser can PUT without a matching header.
    const key = `${prefix}presign-put-untyped.bin`;
    const url = await client.presignPut(key, {}, 60);
    const resp = await fetch(url, { method: 'PUT', body: 'no content type here' });
    expect(resp.status).toBe(200);
    expect(await client.head(key)).not.toBeNull();
    await client.delete(key);
  });
});
