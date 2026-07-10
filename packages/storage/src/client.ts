// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// StorageClient interface — the abstraction the sync worker, upload
// path, and onboarding tools talk to. Implementations:
//
//   - B2StorageClient (./b2.ts) — production. Uses @aws-sdk/client-s3
//     against Backblaze B2's S3-compatible endpoint. Wiring is
//     deferred until real credentials land (per QUESTIONS.md Q32).
//
//   - MockStorageClient (./mock.ts) — dev + tests. Writes under a
//     local filesystem root, exposes the same surface. Presign URLs
//     resolve to internal `mock-presign://` URIs that a thin upload
//     route can translate to fs writes; this keeps the FE upload
//     path identical between dev and prod.
//
// The interface is intentionally narrow. Every B2 quirk (multipart
// upload coordination, conditional GET, server-side copy semantics)
// lives behind these methods.
//
// Why not reuse `apps/api/src/files/storage.ts`? The existing
// adapter (LocalFsAdapter / S3Adapter) was scoped to the v1 file
// manager — it lacks `list(prefix)`, `head`, `copy`, and presign
// surfaces. Reusing it would have meant pulling those into a v1-
// shaped API. Cleaner to start with the addendum's wider interface.

import type { Readable } from 'node:stream';

/** Metadata returned by HEAD or LIST operations. */
export interface StorageObjectMeta {
  /** Full object key (path including leading prefix). */
  key: string;
  /** Size in bytes. NULL on directory placeholders. */
  sizeBytes: number;
  /** Strong ETag from the backend. Used for change detection. */
  etag: string;
  /** Last-modified timestamp from the backend. */
  lastModified: Date;
  /** Inferred or stored content type. */
  contentType?: string;
}

/** A single entry yielded by `list()`. Either a regular object or a
 *  "common prefix" placeholder (S3-speak for a virtual subfolder). */
export interface StorageObject {
  kind: 'object' | 'prefix';
  /** For 'object': the full key. For 'prefix': the prefix string. */
  key: string;
  /** Present on 'object'. */
  meta?: StorageObjectMeta;
}

export interface ListOpts {
  /** Yields 'prefix' entries for keys that share this delimiter
   *  segment after the listed prefix. Default `/`. */
  delimiter?: string;
  /** When true, the client ignores `delimiter` and yields every object
   *  under the prefix as flat 'object' entries (no 'prefix' yields).
   *  Used by the file-level sync worker. */
  recursive?: boolean;
  /** Cap on entries yielded. The iterable still completes cleanly. */
  maxItems?: number;
}

export interface PutOpts {
  contentType?: string;
  /** Optional content-disposition for downloads (filename hint). */
  contentDisposition?: string;
  /** Optional metadata key/value pairs persisted with the object. */
  metadata?: Record<string, string>;
}

export interface PresignPutOpts extends PutOpts {
  /** Optional Content-Length the receiver enforces. */
  expectedSizeBytes?: number;
}

export interface PresignGetOpts {
  /** Overrides the response Content-Type (S3 response-content-type). */
  responseContentType?: string;
  /**
   * Overrides the response Content-Disposition (S3
   * response-content-disposition) — e.g. 'inline' to render in the
   * browser, or `attachment; filename="…"` to force a download.
   */
  responseContentDisposition?: string;
}

/**
 * The minimum surface the sync worker + upload path require.
 * Implementations must be:
 *   - Idempotent for puts at the same key (latest write wins).
 *   - Read-after-write consistent for objects they just wrote.
 *   - Tolerant of empty prefixes (`list()` yields nothing, no error).
 */
export interface StorageClient {
  readonly kind: 'b2' | 'mock';

  /** Lists objects + common prefixes under `prefix`. Yields nothing
   *  if the prefix doesn't exist. */
  list(prefix: string, opts?: ListOpts): AsyncIterable<StorageObject>;

  /** Returns metadata only. NULL if the key doesn't exist. */
  head(key: string): Promise<StorageObjectMeta | null>;

  /** Streams the object body. Throws if the key doesn't exist. */
  get(key: string): Promise<{ body: Readable; meta: StorageObjectMeta }>;

  /** Writes the object atomically. Returns the etag of the new
   *  version. Overwrites silently. */
  put(key: string, body: Buffer | Readable, opts?: PutOpts): Promise<{ etag: string }>;

  /** Removes the object. Idempotent (no error if already absent). */
  delete(key: string): Promise<void>;

  /** Server-side copy. Required by folder-rename so we don't have to
   *  stream large objects through the worker. */
  copy(srcKey: string, destKey: string): Promise<{ etag: string }>;

  /** Returns a URL that grants temporary GET access. Used for portal
   *  downloads. Optional response overrides force how the browser
   *  handles the body — e.g. `responseContentDisposition: 'inline'` +
   *  `responseContentType: 'application/pdf'` for in-browser preview
   *  instead of a download. */
  presignGet(key: string, ttlSeconds: number, opts?: PresignGetOpts): Promise<string>;

  /** Returns a URL that grants temporary PUT access. Used for FE
   *  upload of large files without proxying through the API. */
  presignPut(key: string, opts: PresignPutOpts, ttlSeconds: number): Promise<string>;
}
