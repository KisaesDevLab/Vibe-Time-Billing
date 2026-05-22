// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// MockStorageClient — writes to a local-FS root, exposes the
// StorageClient surface. Used in dev (until real B2 credentials
// land) and in unit/integration tests.
//
// Layout: every key turns into a relative path under `rootPath`.
// Keys with '/' separators land in nested directories. Etags are
// SHA-256 hashes of the body, stored as the hex digest in the
// matching `<key>.etag` sidecar file so HEAD/GET can serve them
// without re-hashing on every call.
//
// Presign URLs are stable opaque tokens of the form:
//   mock-presign://<get|put>/<base64url-encoded-key>?ttl=<seconds>&exp=<unix-ms>
// The dev upload route (Phase 8) parses these and translates to
// direct put()/get() calls. Real B2 presign URLs are HTTPS — the
// FE doesn't care which it gets.

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  ListOpts,
  PresignPutOpts,
  PutOpts,
  StorageClient,
  StorageObject,
  StorageObjectMeta,
} from './client';

export interface MockStorageClientOpts {
  /** Absolute path to the directory that backs the bucket. */
  rootPath: string;
}

export class MockStorageClient implements StorageClient {
  readonly kind = 'mock' as const;
  private readonly root: string;

  constructor(opts: MockStorageClientOpts) {
    this.root = resolve(opts.rootPath);
  }

  private resolveKey(key: string): string {
    // Block traversal. The key is untrusted in the sense that it
    // comes from DB rows + user input upstream; we still refuse any
    // attempt to break out of `root`.
    const normalized = key.replace(/^\/+/, '').replace(/\\+/g, '/');
    if (normalized.includes('..')) {
      throw new Error(`MockStorageClient: illegal key contains '..': ${key}`);
    }
    const abs = resolve(this.root, normalized);
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || rel.startsWith(sep + '..')) {
      throw new Error(`MockStorageClient: key escapes root: ${key}`);
    }
    return abs;
  }

  private etagPath(absPath: string): string {
    return `${absPath}.__etag`;
  }

  async *list(prefix: string, opts?: ListOpts): AsyncIterable<StorageObject> {
    const delimiter = opts?.delimiter ?? '/';
    const maxItems = opts?.maxItems ?? Number.POSITIVE_INFINITY;
    const normalizedPrefix = prefix.replace(/^\/+/, '');
    const absPrefix = this.resolveKey(normalizedPrefix);
    // Determine the directory to scan: if the prefix ends with '/'
    // or is empty, scan the dir; otherwise scan its parent and filter
    // entries that startsWith(prefix).
    const endsWithSlash = normalizedPrefix === '' || normalizedPrefix.endsWith('/');
    const scanDir = endsWithSlash ? absPrefix : dirname(absPrefix);
    const filter = endsWithSlash
      ? ''
      : normalizedPrefix.slice(normalizedPrefix.lastIndexOf('/') + 1);

    let entries: { name: string; isDirectory: boolean }[] = [];
    try {
      const raw = await fs.readdir(scanDir, { withFileTypes: true });
      entries = raw
        .filter((e) => !e.name.endsWith('.__etag'))
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    // Sort lexically — mirrors what B2/S3 returns.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    let count = 0;
    const dirRel = relative(this.root, scanDir).replace(/\\+/g, '/');
    const dirPrefix = dirRel.length === 0 ? '' : `${dirRel}/`;

    for (const e of entries) {
      if (filter && !e.name.startsWith(filter)) continue;
      if (count >= maxItems) return;
      count += 1;

      const key = `${dirPrefix}${e.name}`;
      if (e.isDirectory) {
        if (delimiter === '/') {
          yield { kind: 'prefix', key: `${key}/` };
          continue;
        }
        // Non-'/' delimiter: recurse and yield as objects.
        yield* this.list(`${key}/`, opts);
        continue;
      }
      const abs = join(scanDir, e.name);
      const meta = await this.metaFor(key, abs);
      if (meta) yield { kind: 'object', key, meta };
    }
  }

  private async metaFor(key: string, absPath: string): Promise<StorageObjectMeta | null> {
    try {
      const stat = await fs.stat(absPath);
      let etag: string;
      try {
        etag = (await fs.readFile(this.etagPath(absPath), 'utf8')).trim();
      } catch {
        // Hash on demand if the sidecar is missing.
        etag = await hashFile(absPath);
        await fs.writeFile(this.etagPath(absPath), etag, 'utf8');
      }
      return {
        key,
        sizeBytes: stat.size,
        etag,
        lastModified: stat.mtime,
        // We don't persist content-type in mock storage; callers
        // shouldn't depend on it for routing.
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async head(key: string): Promise<StorageObjectMeta | null> {
    const abs = this.resolveKey(key);
    return this.metaFor(key, abs);
  }

  async get(key: string): Promise<{ body: Readable; meta: StorageObjectMeta }> {
    const abs = this.resolveKey(key);
    const meta = await this.metaFor(key, abs);
    if (!meta) throw new Error(`MockStorageClient: object not found: ${key}`);
    return { body: createReadStream(abs), meta };
  }

  async put(key: string, body: Buffer | Readable, opts?: PutOpts): Promise<{ etag: string }> {
    void opts; // Mock doesn't persist content-type / metadata.
    const abs = this.resolveKey(key);
    await fs.mkdir(dirname(abs), { recursive: true });
    let etag: string;
    if (Buffer.isBuffer(body)) {
      await fs.writeFile(abs, body);
      etag = createHash('sha256').update(body).digest('hex');
    } else {
      const hash = createHash('sha256');
      const tap = body as Readable;
      tap.on('data', (chunk) => hash.update(chunk));
      await pipeline(tap, createWriteStream(abs));
      etag = hash.digest('hex');
    }
    await fs.writeFile(this.etagPath(abs), etag, 'utf8');
    return { etag };
  }

  async delete(key: string): Promise<void> {
    const abs = this.resolveKey(key);
    await fs.rm(abs, { force: true });
    await fs.rm(this.etagPath(abs), { force: true });
  }

  async copy(srcKey: string, destKey: string): Promise<{ etag: string }> {
    const src = this.resolveKey(srcKey);
    const dest = this.resolveKey(destKey);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    // Recompute etag rather than copy the sidecar, since the dest
    // is a new logical object even though the bytes match.
    const etag = await hashFile(dest);
    await fs.writeFile(this.etagPath(dest), etag, 'utf8');
    return { etag };
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return buildPresignUrl('get', key, ttlSeconds);
  }

  async presignPut(key: string, opts: PresignPutOpts, ttlSeconds: number): Promise<string> {
    void opts; // Mock doesn't enforce content-type / size at the URL.
    return buildPresignUrl('put', key, ttlSeconds);
  }
}

function buildPresignUrl(kind: 'get' | 'put', key: string, ttlSeconds: number): string {
  const exp = Date.now() + ttlSeconds * 1000;
  const encoded = Buffer.from(key, 'utf8').toString('base64url');
  return `mock-presign://${kind}/${encoded}?ttl=${ttlSeconds}&exp=${exp}`;
}

/**
 * Parses a mock-presign URL back into its parts. Used by the dev
 * upload route in Phase 8.
 */
export function parseMockPresignUrl(url: string): {
  kind: 'get' | 'put';
  key: string;
  expiresAt: number;
} | null {
  const match = /^mock-presign:\/\/(get|put)\/([^?]+)\?ttl=\d+&exp=(\d+)$/.exec(url);
  if (!match) return null;
  const kind = match[1] as 'get' | 'put';
  const key = Buffer.from(match[2]!, 'base64url').toString('utf8');
  const expiresAt = Number(match[3]);
  return { kind, key, expiresAt };
}

async function hashFile(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(absPath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield chunk;
    }
  });
  return hash.digest('hex');
}
