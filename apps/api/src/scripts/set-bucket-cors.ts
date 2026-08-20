// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Apply the CORS policy the browser upload path requires to the
// configured B2/MinIO bucket.
//
// The FE uploads file bodies straight to storage with a presigned PUT
// (and previews/downloads via presigned GET), so the bucket must allow
// cross-origin PUT/GET/HEAD from the staff, portal, and intake origins.
// Without this the browser blocks the presigned request and every
// upload fails with a CORS error — the API never sees it.
//
// Origins come from APP_BASE_URL / PORTAL_BASE_URL / INTAKE_BASE_URL.
// Dry-run by default (prints current + proposed rules). --execute applies.
//
// Usage (inside the appliance container):
//   DATABASE_URL=... node .../set-bucket-cors.js [--execute]

import { createRequire } from 'node:module';

import { createDb } from '@vibe/db';

import { bootCrypto } from '../crypto/boot';
import { applyStorageSettingsFromDb } from '../admin/storage-settings/boot';

interface CorsRule {
  AllowedOrigins: string[];
  AllowedMethods: string[];
  AllowedHeaders: string[];
  ExposeHeaders: string[];
  MaxAgeSeconds: number;
}
interface S3Like {
  send(cmd: unknown): Promise<{ CORSRules?: CorsRule[] }>;
}
interface AwsS3Module {
  S3Client: new (cfg: unknown) => S3Like;
  GetBucketCorsCommand: new (input: { Bucket?: string }) => unknown;
  PutBucketCorsCommand: new (input: {
    Bucket?: string;
    CORSConfiguration: { CORSRules: CorsRule[] };
  }) => unknown;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const execute = process.argv.includes('--execute');

  const origins = [
    process.env['APP_BASE_URL'],
    process.env['PORTAL_BASE_URL'],
    process.env['INTAKE_BASE_URL'],
  ].filter((o): o is string => Boolean(o && o.startsWith('https://')));
  if (origins.length === 0) {
    throw new Error('No https app origins found in APP/PORTAL/INTAKE_BASE_URL');
  }

  const { db, close } = createDb({ connectionString: databaseUrl });
  try {
    await bootCrypto(db);
    await applyStorageSettingsFromDb(db);
    if ((process.env['STORAGE_PROVIDER'] ?? 'mock') === 'mock') {
      console.log('storage provider is mock — nothing to do.');
      return;
    }

    // @aws-sdk/client-s3 is a dependency of @vibe/storage, not of the
    // api package — resolve it from the storage package's context.
    const requireHere = createRequire(import.meta.url);
    const requireFromStorage = createRequire(requireHere.resolve('@vibe/storage'));
    // reason: structural cast — the SDK ships its own types but they are
    // not visible from this package; the narrow surface used here is typed
    // by AwsS3Module above.
    const { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } = requireFromStorage(
      '@aws-sdk/client-s3',
    ) as AwsS3Module;

    const bucket = process.env['B2_BUCKET'] ?? process.env['MINIO_BUCKET'];
    const s3 = new S3Client({
      endpoint: process.env['B2_ENDPOINT'] ?? process.env['MINIO_ENDPOINT'],
      region: process.env['B2_REGION'] ?? process.env['MINIO_REGION'],
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env['B2_KEY_ID'] ?? process.env['MINIO_ACCESS_KEY'] ?? '',
        secretAccessKey: process.env['B2_APPLICATION_KEY'] ?? process.env['MINIO_SECRET_KEY'] ?? '',
      },
    });

    try {
      const current = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
      console.log(`current CORS rules: ${JSON.stringify(current.CORSRules)}`);
    } catch {
      console.log('current CORS rules: (none)');
    }

    const rules = [
      {
        AllowedOrigins: origins,
        AllowedMethods: ['GET', 'PUT', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      },
    ];
    console.log(`proposed CORS rules: ${JSON.stringify(rules)}`);
    if (!execute) {
      console.log('[dry-run] pass --execute to apply');
      return;
    }
    await s3.send(
      new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules } }),
    );
    const after = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
    console.log(`applied. CORS rules now: ${JSON.stringify(after.CORSRules)}`);
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
