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

const StorageEnvSchema = z.object({
  STORAGE_PROVIDER: z.enum(['mock', 'b2']).default('mock'),

  // Mock provider
  STORAGE_LOCAL_PATH: z.string().default('/data/storage-mock'),

  // B2 provider
  B2_ENDPOINT: z.string().optional(),
  B2_REGION: z.string().optional(),
  B2_BUCKET: z.string().optional(),
  B2_KEY_ID: z.string().optional(),
  B2_APPLICATION_KEY: z.string().optional(),

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
  return new MockStorageClient({
    rootPath: cfg.STORAGE_LOCAL_PATH,
  } satisfies MockStorageClientOpts);
}
