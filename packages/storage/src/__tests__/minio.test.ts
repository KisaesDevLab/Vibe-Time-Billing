// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P13 — MinIO provider routing tests.
//
// We don't talk to a real MinIO instance here — just verify that the
// factory routes STORAGE_PROVIDER=minio to the S3-compatible B2 client
// with MINIO_* env vars correctly translated.

import { describe, expect, it } from 'vitest';
import { B2StorageClient, buildStorageClient, MockStorageClient } from '../index';

describe('P13 — MinIO env routing', () => {
  it('STORAGE_PROVIDER=minio with creds → B2StorageClient (S3 protocol)', () => {
    const client = buildStorageClient({
      STORAGE_PROVIDER: 'minio',
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_REGION: 'us-east-1',
      MINIO_BUCKET: 'vibetb',
      MINIO_ACCESS_KEY: 'admin',
      MINIO_SECRET_KEY: 'secretpassword',
    } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(B2StorageClient);
  });

  it('STORAGE_PROVIDER=minio without creds → throws with helpful message', () => {
    expect(() =>
      buildStorageClient({
        STORAGE_PROVIDER: 'minio',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MINIO_ACCESS_KEY.*MINIO_SECRET_KEY/);
  });

  it('STORAGE_PROVIDER=mock → MockStorageClient (default)', () => {
    const client = buildStorageClient({} as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(MockStorageClient);
  });

  it('MinIO defaults wire up usable endpoint + bucket if not overridden', () => {
    // Just verifying the factory accepts minimum required creds and
    // doesn't throw — the defaults come from the schema.
    expect(() =>
      buildStorageClient({
        STORAGE_PROVIDER: 'minio',
        MINIO_ACCESS_KEY: 'admin',
        MINIO_SECRET_KEY: 'secret',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
