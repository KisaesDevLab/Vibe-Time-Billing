// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// @vibe/storage public surface. The factory `buildStorageClient`
// inspects the env vars and picks B2 (production) vs Mock
// (dev/test). Real B2 wiring is gated on @aws-sdk/* being installed;
// see QUESTIONS.md Q32 for the deferred-credentials decision.

import { z } from 'zod';

import { B2StorageClient, type B2StorageClientOpts } from './b2';
import type { StorageClient } from './client';
import { MockStorageClient, type MockStorageClientOpts } from './mock';

export * from './client';
export * from './paths';
export * from './sentinel';
export { MockStorageClient, parseMockPresignUrl } from './mock';
export { B2StorageClient } from './b2';
export * from './normalize';
export * from './jaro-winkler';
export * from './match-engine';

const StorageEnvSchema = z.object({
  // P13 — MinIO is S3-protocol-compatible and uses the same client
  // implementation as B2. Selecting `minio` reads MINIO_* env vars
  // (with sensible defaults for an in-cluster sidecar) and rebinds
  // them to the underlying B2/S3 client options.
  STORAGE_PROVIDER: z.enum(['mock', 'b2', 'minio']).default('mock'),

  // Mock provider
  STORAGE_LOCAL_PATH: z.string().default('/data/storage-mock'),

  // B2 provider
  B2_ENDPOINT: z.string().optional(),
  B2_REGION: z.string().optional(),
  B2_BUCKET: z.string().optional(),
  B2_KEY_ID: z.string().optional(),
  B2_APPLICATION_KEY: z.string().optional(),

  // MinIO provider — defaults match the docker-compose sidecar so a
  // greenfield appliance boots with usable storage out of the box.
  MINIO_ENDPOINT: z.string().default('http://minio:9000'),
  MINIO_REGION: z.string().default('us-east-1'),
  MINIO_BUCKET: z.string().default('vibetb'),
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),

  // Storage layout (used by the sync worker; carried here for
  // completeness — the layout config is validated at boot, not
  // per-request).
  STORAGE_TOP_PREFIX: z.string().default(''),
  STORAGE_SYSTEM_PREFIX: z.string().default('_system/'),
  STORAGE_SENTINEL_FOLDER: z.string().default('_Vibe'),
  STORAGE_SENTINEL_FILE: z.string().default('client.json'),
});

export type StorageEnv = z.infer<typeof StorageEnvSchema>;

export function loadStorageEnv(env: NodeJS.ProcessEnv = process.env): StorageEnv {
  return StorageEnvSchema.parse(env);
}

/**
 * Returns the configured StorageClient. Throws at boot with a clear
 * error if `STORAGE_PROVIDER=b2` but any B2_* env var is missing.
 */
export function buildStorageClient(env: NodeJS.ProcessEnv = process.env): StorageClient {
  const cfg = loadStorageEnv(env);
  if (cfg.STORAGE_PROVIDER === 'b2') {
    const missing: string[] = [];
    if (!cfg.B2_ENDPOINT) missing.push('B2_ENDPOINT');
    if (!cfg.B2_REGION) missing.push('B2_REGION');
    if (!cfg.B2_BUCKET) missing.push('B2_BUCKET');
    if (!cfg.B2_KEY_ID) missing.push('B2_KEY_ID');
    if (!cfg.B2_APPLICATION_KEY) missing.push('B2_APPLICATION_KEY');
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_PROVIDER=b2 but missing required env: ${missing.join(', ')}.\n` +
          'Set the B2_* vars or use STORAGE_PROVIDER=mock for dev.',
      );
    }
    return new B2StorageClient({
      endpoint: cfg.B2_ENDPOINT!,
      region: cfg.B2_REGION!,
      bucket: cfg.B2_BUCKET!,
      accessKeyId: cfg.B2_KEY_ID!,
      secretAccessKey: cfg.B2_APPLICATION_KEY!,
    } satisfies B2StorageClientOpts);
  }
  if (cfg.STORAGE_PROVIDER === 'minio') {
    const missing: string[] = [];
    if (!cfg.MINIO_ACCESS_KEY) missing.push('MINIO_ACCESS_KEY');
    if (!cfg.MINIO_SECRET_KEY) missing.push('MINIO_SECRET_KEY');
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_PROVIDER=minio but missing required env: ${missing.join(', ')}.\n` +
          'Set MINIO_ACCESS_KEY + MINIO_SECRET_KEY, or use STORAGE_PROVIDER=mock for dev.',
      );
    }
    return new B2StorageClient({
      endpoint: cfg.MINIO_ENDPOINT,
      region: cfg.MINIO_REGION,
      bucket: cfg.MINIO_BUCKET,
      accessKeyId: cfg.MINIO_ACCESS_KEY!,
      secretAccessKey: cfg.MINIO_SECRET_KEY!,
    } satisfies B2StorageClientOpts);
  }
  return new MockStorageClient({
    rootPath: cfg.STORAGE_LOCAL_PATH,
  } satisfies MockStorageClientOpts);
}
