// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// B2StorageClient — production. Uses @aws-sdk/client-s3 against
// Backblaze B2's S3-compatible endpoint. Wiring deferred until
// credentials arrive (QUESTIONS.md Q32). The implementation is
// structurally complete but the @aws-sdk/* packages are declared as
// optional peer deps so dev installs without B2 don't need them.
// The dynamic import + try/catch lets us boot cleanly with mock
// storage and surface a clear error only if someone actually picks
// the B2 provider without installing the SDK.

import type { Readable } from 'node:stream';

import type {
  ListOpts,
  PresignPutOpts,
  PutOpts,
  StorageClient,
  StorageObject,
  StorageObjectMeta,
} from './client';

export interface B2StorageClientOpts {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** B2 needs path-style addressing because the S3-compat layer
   *  doesn't support virtual-hosted-style for all bucket names. */
  forcePathStyle?: boolean;
  /** Optional per-request retry override. Defaults to 5. */
  maxRetries?: number;
}

// reason: the @aws-sdk packages are optional peer deps; the dynamic
// import here lets the module load in environments where they
// aren't installed (mock storage path). The concrete types come from
// the SDK at runtime — we type them as `unknown` at the boundary.
/* eslint-disable @typescript-eslint/no-explicit-any */
type S3ClientLike = any;
type S3CommandLike = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface S3Module {
  S3Client: new (config: Record<string, unknown>) => S3ClientLike;
  ListObjectsV2Command: new (input: Record<string, unknown>) => S3CommandLike;
  HeadObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  GetObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  PutObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  DeleteObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  CopyObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
}

interface PresignerModule {
  getSignedUrl: (
    client: S3ClientLike,
    command: S3CommandLike,
    opts: { expiresIn: number },
  ) => Promise<string>;
}

let s3ModulePromise: Promise<S3Module> | null = null;
let presignerModulePromise: Promise<PresignerModule> | null = null;

async function loadS3Module(): Promise<S3Module> {
  if (!s3ModulePromise) {
    s3ModulePromise = (async () => {
      try {
        // reason: dynamic import string is intentionally opaque so
        // bundlers don't pre-resolve when @aws-sdk isn't installed.
        const mod = (await import(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          '@aws-sdk/client-s3' as any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        )) as any as S3Module;
        return mod;
      } catch {
        throw new Error(
          'B2StorageClient requires @aws-sdk/client-s3 — install it with `pnpm --filter @vibe/storage add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` before setting STORAGE_PROVIDER=b2.',
        );
      }
    })();
  }
  return s3ModulePromise;
}

async function loadPresignerModule(): Promise<PresignerModule> {
  if (!presignerModulePromise) {
    presignerModulePromise = (async () => {
      try {
        const mod = (await import(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          '@aws-sdk/s3-request-presigner' as any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        )) as any as PresignerModule;
        return mod;
      } catch {
        throw new Error('B2StorageClient presign requires @aws-sdk/s3-request-presigner.');
      }
    })();
  }
  return presignerModulePromise;
}

export class B2StorageClient implements StorageClient {
  readonly kind = 'b2' as const;
  private clientPromise: Promise<S3ClientLike> | null = null;
  private readonly bucket: string;

  constructor(private readonly opts: B2StorageClientOpts) {
    this.bucket = opts.bucket;
  }

  private async client(): Promise<S3ClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { S3Client } = await loadS3Module();
        return new S3Client({
          endpoint: this.opts.endpoint,
          region: this.opts.region,
          credentials: {
            accessKeyId: this.opts.accessKeyId,
            secretAccessKey: this.opts.secretAccessKey,
          },
          forcePathStyle: this.opts.forcePathStyle ?? true,
          maxAttempts: this.opts.maxRetries ?? 5,
        });
      })();
    }
    return this.clientPromise;
  }

  async *list(prefix: string, opts?: ListOpts): AsyncIterable<StorageObject> {
    const { ListObjectsV2Command } = await loadS3Module();
    const client = await this.client();
    // Recursive listing omits Delimiter entirely so B2 returns every
    // object below the prefix in a single sweep (no CommonPrefixes).
    const delimiter = opts?.recursive ? undefined : (opts?.delimiter ?? '/');
    const maxItems = opts?.maxItems ?? Number.POSITIVE_INFINITY;
    let token: string | undefined = undefined;
    let yielded = 0;
    do {
      const out: {
        CommonPrefixes?: { Prefix?: string }[];
        Contents?: {
          Key?: string;
          Size?: number;
          ETag?: string;
          LastModified?: Date;
        }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      } = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: delimiter,
          ContinuationToken: token,
        }),
      );
      for (const p of out.CommonPrefixes ?? []) {
        if (!p.Prefix) continue;
        if (yielded >= maxItems) return;
        yielded += 1;
        yield { kind: 'prefix', key: p.Prefix };
      }
      for (const o of out.Contents ?? []) {
        if (!o.Key) continue;
        if (yielded >= maxItems) return;
        yielded += 1;
        yield {
          kind: 'object',
          key: o.Key,
          meta: {
            key: o.Key,
            sizeBytes: o.Size ?? 0,
            etag: (o.ETag ?? '').replace(/"/g, ''),
            lastModified: o.LastModified ?? new Date(),
          },
        };
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  async head(key: string): Promise<StorageObjectMeta | null> {
    const { HeadObjectCommand } = await loadS3Module();
    const client = await this.client();
    try {
      const out: {
        ContentLength?: number;
        ETag?: string;
        LastModified?: Date;
        ContentType?: string;
      } = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        sizeBytes: out.ContentLength ?? 0,
        etag: (out.ETag ?? '').replace(/"/g, ''),
        lastModified: out.LastModified ?? new Date(),
        contentType: out.ContentType,
      };
    } catch (err) {
      // S3 emits a NotFound error on missing keys.
      if (
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 ||
        (err as { name?: string }).name === 'NotFound'
      ) {
        return null;
      }
      throw err;
    }
  }

  async get(key: string): Promise<{ body: Readable; meta: StorageObjectMeta }> {
    const { GetObjectCommand } = await loadS3Module();
    const client = await this.client();
    const out: {
      Body?: Readable;
      ContentLength?: number;
      ETag?: string;
      LastModified?: Date;
      ContentType?: string;
    } = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error(`B2StorageClient: empty body for ${key}`);
    return {
      body: out.Body,
      meta: {
        key,
        sizeBytes: out.ContentLength ?? 0,
        etag: (out.ETag ?? '').replace(/"/g, ''),
        lastModified: out.LastModified ?? new Date(),
        contentType: out.ContentType,
      },
    };
  }

  async put(key: string, body: Buffer | Readable, opts?: PutOpts): Promise<{ etag: string }> {
    const { PutObjectCommand } = await loadS3Module();
    const client = await this.client();
    const out: { ETag?: string } = await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
        ContentDisposition: opts?.contentDisposition,
        Metadata: opts?.metadata,
      }),
    );
    return { etag: (out.ETag ?? '').replace(/"/g, '') };
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await loadS3Module();
    const client = await this.client();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async copy(srcKey: string, destKey: string): Promise<{ etag: string }> {
    const { CopyObjectCommand } = await loadS3Module();
    const client = await this.client();
    // CopySource must be "bucket/keyComponents...". encodeURIComponent
    // encodes '/' as %2F which B2 can't resolve back to a real object,
    // so any nested key (Smith/Invoices/2024.pdf) returns 404 NoSuchKey.
    // Encode each path component separately and rejoin with literal '/'.
    const encodedKey = srcKey
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const out: { CopyObjectResult?: { ETag?: string } } = await client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodedKey}`,
        Key: destKey,
      }),
    );
    return { etag: (out.CopyObjectResult?.ETag ?? '').replace(/"/g, '') };
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    const { GetObjectCommand } = await loadS3Module();
    const { getSignedUrl } = await loadPresignerModule();
    const client = await this.client();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async presignPut(key: string, opts: PresignPutOpts, ttlSeconds: number): Promise<string> {
    const { PutObjectCommand } = await loadS3Module();
    const { getSignedUrl } = await loadPresignerModule();
    const client = await this.client();
    // Only include ContentType / ContentLength when the caller actually
    // supplied them. SigV4 includes any header set on the command in
    // the signature — and B2 rejects with 403 SignatureDoesNotMatch if
    // the browser's PUT doesn't echo the same value. Browsers leave
    // Content-Type empty for files with unknown MIME types and may
    // disagree on Content-Length when intermediaries (corporate
    // proxies / DLP appliances) rewrite the body. Size is verified
    // server-side on /complete via HEAD anyway.
    const putInput: {
      Bucket: string;
      Key: string;
      ContentType?: string;
      ContentDisposition?: string;
      Metadata?: Record<string, string>;
    } = {
      Bucket: this.bucket,
      Key: key,
    };
    if (opts.contentType) putInput.ContentType = opts.contentType;
    if (opts.contentDisposition) putInput.ContentDisposition = opts.contentDisposition;
    if (opts.metadata) putInput.Metadata = opts.metadata;
    return getSignedUrl(client, new PutObjectCommand(putInput), { expiresIn: ttlSeconds });
  }
}
