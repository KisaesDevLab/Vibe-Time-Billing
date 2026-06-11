// SPDX-License-Identifier: Elastic-2.0
//
// File storage adapter (v2 Sprint C, workstream 1.4).
//
// Locked decision: local FS in dev, MinIO/S3 in prod. Selection driven
// by FILE_STORAGE env var:
//   - "local" (default) writes under FILE_LOCAL_PATH (default /data/files)
//   - "s3" writes to S3_BUCKET using S3_REGION + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY
//     (and an optional S3_ENDPOINT for MinIO)
//
// Adapters expose a tight interface: put / get / delete / signedReadUrl.
// The "signed read" path for the local adapter returns an internal token
// that maps to the storage_path; the API route resolves the token and
// streams the file directly. For S3 it returns a proper presigned URL.

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

export interface PutInput {
  firmId: string;
  clientId: string;
  fileName: string;
  mimeType: string;
  body: Readable | Buffer;
}

export interface PutResult {
  storagePath: string;
  sizeBytes: number;
}

export interface StorageAdapter {
  id: 'local' | 's3';
  put(input: PutInput): Promise<PutResult>;
  /** Returns a readable stream for the blob and its mime type. */
  get(storagePath: string): Promise<{ stream: Readable; mimeType?: string }>;
  /** Soft delete = blob removal. The DB row's status is the source of truth. */
  delete(storagePath: string): Promise<void>;
}

// ----- Local FS adapter (dev + as a fallback) -----

export class LocalFsAdapter implements StorageAdapter {
  readonly id = 'local';
  constructor(private readonly rootPath: string) {}

  private resolve(storagePath: string): string {
    // storage_path is "<firm>/<client>/<uuid>". Refuse any path with
    // .. or absolute references; we never trust DB content as a path.
    if (storagePath.includes('..') || storagePath.startsWith('/') || storagePath.includes(':')) {
      throw new Error('illegal storage path');
    }
    return join(this.rootPath, storagePath);
  }

  async put(input: PutInput): Promise<PutResult> {
    const key = `${input.firmId}/${input.clientId}/${randomUUID()}`;
    const target = this.resolve(key);
    await fs.mkdir(dirname(target), { recursive: true });
    let sizeBytes = 0;
    if (Buffer.isBuffer(input.body)) {
      await fs.writeFile(target, input.body);
      sizeBytes = input.body.length;
    } else {
      const out = createWriteStream(target);
      // Track size while streaming through a passthrough is overkill;
      // statvfs after write is the simpler reliable path.
      await pipeline(input.body, out);
      const stat = await fs.stat(target);
      sizeBytes = stat.size;
    }
    return { storagePath: key, sizeBytes };
  }

  async get(storagePath: string): Promise<{ stream: Readable }> {
    const target = this.resolve(storagePath);
    // Throws ENOENT if missing — caller handles.
    await fs.access(target);
    return { stream: createReadStream(target) };
  }

  async delete(storagePath: string): Promise<void> {
    const target = this.resolve(storagePath);
    await fs.unlink(target).catch((err: NodeJS.ErrnoException) => {
      // Idempotent delete: ENOENT is fine.
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

// ----- S3 adapter (prod MinIO / AWS / R2) -----
//
// Implemented as a thin wrapper so callers don't need @aws-sdk loaded in
// dev. The dynamic import keeps the dev dependency surface tight.

export interface S3AdapterOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string; // MinIO needs this; AWS does not
  forcePathStyle?: boolean; // MinIO needs true
}

export class S3Adapter implements StorageAdapter {
  readonly id = 's3';
  constructor(private readonly opts: S3AdapterOptions) {}

  private async client(): Promise<{
    send: <Out>(cmd: unknown) => Promise<Out>;
    PutObjectCommand: unknown;
    GetObjectCommand: unknown;
    DeleteObjectCommand: unknown;
  }> {
    // Dynamic import: @aws-sdk is optional in dev. If absent, throw a
    // clear error so the operator knows to install it.
    // reason: package is an optional peer dep — typecheck can't see it
    // until the prod deps are installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sdk: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk = await (import('@aws-sdk/client-s3' as any) as Promise<any>);
    } catch {
      throw new Error('@aws-sdk/client-s3 not installed — required for S3 file storage');
    }
    const client = new sdk.S3Client({
      region: this.opts.region,
      credentials: {
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
      },
      endpoint: this.opts.endpoint,
      forcePathStyle: this.opts.forcePathStyle ?? Boolean(this.opts.endpoint),
    });
    return {
      send: <Out>(cmd: unknown) => client.send(cmd as never) as Promise<Out>,
      PutObjectCommand: sdk.PutObjectCommand,
      GetObjectCommand: sdk.GetObjectCommand,
      DeleteObjectCommand: sdk.DeleteObjectCommand,
    };
  }

  async put(input: PutInput): Promise<PutResult> {
    const key = `${input.firmId}/${input.clientId}/${randomUUID()}`;
    const client = await this.client();
    let body: Buffer;
    if (Buffer.isBuffer(input.body)) {
      body = input.body;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      body = Buffer.concat(chunks);
    }
    const PutObjectCommand = client.PutObjectCommand as new (input: object) => unknown;
    await client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: input.mimeType,
      }),
    );
    return { storagePath: key, sizeBytes: body.length };
  }

  async get(storagePath: string): Promise<{ stream: Readable; mimeType?: string }> {
    const client = await this.client();
    const GetObjectCommand = client.GetObjectCommand as new (input: object) => unknown;
    const out = await client.send<{
      Body?: Readable;
      ContentType?: string;
    }>(new GetObjectCommand({ Bucket: this.opts.bucket, Key: storagePath }));
    if (!out.Body) throw new Error('s3 get returned no body');
    return { stream: out.Body, mimeType: out.ContentType };
  }

  async delete(storagePath: string): Promise<void> {
    const client = await this.client();
    const DeleteObjectCommand = client.DeleteObjectCommand as new (input: object) => unknown;
    await client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: storagePath }));
  }
}

// ----- Factory -----

export interface StorageEnv {
  FILE_STORAGE?: string;
  FILE_LOCAL_PATH?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_ENDPOINT?: string;
  S3_FORCE_PATH_STYLE?: string;
}

export function buildStorageAdapter(env: StorageEnv = process.env): StorageAdapter {
  const mode = (env.FILE_STORAGE ?? 'local').toLowerCase();
  if (mode === 's3') {
    if (!env.S3_BUCKET || !env.S3_REGION || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error(
        'FILE_STORAGE=s3 requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY',
      );
    }
    return new S3Adapter({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    });
  }
  return new LocalFsAdapter(env.FILE_LOCAL_PATH ?? '/data/files');
}
