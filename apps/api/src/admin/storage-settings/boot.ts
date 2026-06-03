// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// applyStorageSettingsFromDb — boot-time helper. Reads the firm's
// storage_settings row (single-firm appliance), decrypts the sealed
// credentials with the FirmKeyManager, and writes them into
// process.env so every subsequent `buildStorageClient(process.env)`
// call resolves to the operator's configured provider.
//
// The env-var fallback is preserved: when no DB row exists, the
// existing STORAGE_PROVIDER / B2_* / MINIO_* values stay untouched.
// When a DB row exists, it wins (DB overrides env).

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firms, storageSettings } from '@vibe/db/schema';

import { getFirmKeyManager } from '../../crypto/manager';
import { logger } from '../../logger';

function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export async function applyStorageSettingsFromDb(db: Database | null): Promise<void> {
  if (!db) return;
  let firmId: string | undefined;
  try {
    const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
    if (!firm) return;
    firmId = firm.id;
    const [row] = await db
      .select()
      .from(storageSettings)
      .where(eq(storageSettings.firmId, firmId))
      .limit(1);
    if (!row) return;

    const mgr = getFirmKeyManager(db);

    if (row.provider === 'b2') {
      if (!row.b2Endpoint || !row.b2Region || !row.b2Bucket) {
        logger.warn(
          { firmId },
          'storage settings: provider=b2 but missing endpoint/region/bucket; keeping env vars',
        );
        return;
      }
      if (!row.b2KeyIdEncrypted || !row.b2ApplicationKeyEncrypted) {
        logger.warn(
          { firmId },
          'storage settings: provider=b2 but credentials not set; keeping env vars',
        );
        return;
      }
      const keyId = fromUtf8(mgr.unwrapTDek(firmId, row.b2KeyIdEncrypted));
      const appKey = fromUtf8(mgr.unwrapTDek(firmId, row.b2ApplicationKeyEncrypted));
      process.env['STORAGE_PROVIDER'] = 'b2';
      process.env['B2_ENDPOINT'] = row.b2Endpoint;
      process.env['B2_REGION'] = row.b2Region;
      process.env['B2_BUCKET'] = row.b2Bucket;
      process.env['B2_KEY_ID'] = keyId;
      process.env['B2_APPLICATION_KEY'] = appKey;
      logger.info(
        { firmId, bucket: row.b2Bucket, region: row.b2Region },
        'storage settings: B2 config applied from DB',
      );
      return;
    }

    if (row.provider === 'minio') {
      if (!row.minioEndpoint || !row.minioRegion || !row.minioBucket) {
        logger.warn(
          { firmId },
          'storage settings: provider=minio but missing endpoint/region/bucket; keeping env vars',
        );
        return;
      }
      if (!row.minioAccessKeyEncrypted || !row.minioSecretKeyEncrypted) {
        logger.warn(
          { firmId },
          'storage settings: provider=minio but credentials not set; keeping env vars',
        );
        return;
      }
      const accessKey = fromUtf8(mgr.unwrapTDek(firmId, row.minioAccessKeyEncrypted));
      const secretKey = fromUtf8(mgr.unwrapTDek(firmId, row.minioSecretKeyEncrypted));
      process.env['STORAGE_PROVIDER'] = 'minio';
      process.env['MINIO_ENDPOINT'] = row.minioEndpoint;
      process.env['MINIO_REGION'] = row.minioRegion;
      process.env['MINIO_BUCKET'] = row.minioBucket;
      process.env['MINIO_ACCESS_KEY'] = accessKey;
      process.env['MINIO_SECRET_KEY'] = secretKey;
      logger.info(
        { firmId, bucket: row.minioBucket, region: row.minioRegion },
        'storage settings: MinIO config applied from DB',
      );
      return;
    }

    // provider === 'mock' — explicitly clear so env-var residue doesn't
    // accidentally re-enable a previous remote provider.
    process.env['STORAGE_PROVIDER'] = 'mock';
    logger.info({ firmId }, 'storage settings: mock provider selected from DB');
  } catch (err) {
    logger.error({ err, firmId }, 'storage settings: apply-from-db failed; falling back to env');
  }
}
