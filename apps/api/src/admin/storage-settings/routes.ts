// SPDX-License-Identifier: Elastic-2.0
//
// Admin → Storage settings. UI-driven configuration for STORAGE_PROVIDER
// + B2 / MinIO credentials. Until now this was env-var only; admins
// can now paste credentials from the appliance UI and (after a
// restart) the boot path picks them up.
//
// Endpoints (all gated by firm:settings:write except GET which uses
// firm:settings:read):
//   GET   /  — current provider + non-secret fields + masked hints
//   PUT   /  — save provider + credentials (encrypts with MFK)
//   POST  /test — verify a credential set with a list + put + delete
//                  in a temp prefix. Body is the proposed config (not
//                  yet saved) so the admin can verify before committing.
//
// Secrets are wrapped with the firm's Master Firm Key (FirmKeyManager.
// wrapTDek). The KEK never leaves the API process.

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { storageSettings } from '@vibe/db/schema';
import { B2StorageClient } from '@vibe/storage';

import { emitAudit } from '../../auth/audit';
import { requirePermission, type RbacDeps } from '../../auth/rbac-middleware';
import { getFirmKeyManager } from '../../crypto/manager';
import { logger } from '../../logger';

export interface StorageSettingsRoutesDeps extends RbacDeps {
  db: Database | null;
}

const ProviderEnum = z.enum(['mock', 'b2', 'minio']);

const B2Schema = z.object({
  endpoint: z.string().url(),
  region: z.string().min(1).max(40),
  bucket: z.string().min(1).max(120),
  keyId: z.string().min(1).max(200),
  // Application key only required on first save / rotation. When the
  // admin re-submits without a value, the existing stored secret is
  // kept (the UI shows a masked hint).
  applicationKey: z.string().min(1).max(500).optional(),
});

const MinioSchema = z.object({
  endpoint: z.string().url(),
  region: z.string().min(1).max(40),
  bucket: z.string().min(1).max(120),
  accessKey: z.string().min(1).max(200),
  secretKey: z.string().min(1).max(500).optional(),
});

const PutSchema = z.object({
  provider: ProviderEnum,
  b2: B2Schema.optional(),
  minio: MinioSchema.optional(),
});

// Test payloads may omit BOTH the key id and the secret: the UI leaves
// them blank ("saved — leave blank to keep") when re-testing already-
// stored credentials. The handler unwraps the sealed key id / secret in
// that case. So keyId/accessKey are optional (blank allowed) and the
// secret stays optional — validation must not block the stored-cred path.
const B2TestSchema = z.object({
  endpoint: z.string().url(),
  region: z.string().min(1).max(40),
  bucket: z.string().min(1).max(120),
  keyId: z.string().max(200).optional(),
  applicationKey: z.string().max(500).optional(),
});
const MinioTestSchema = z.object({
  endpoint: z.string().url(),
  region: z.string().min(1).max(40),
  bucket: z.string().min(1).max(120),
  accessKey: z.string().max(200).optional(),
  secretKey: z.string().max(500).optional(),
});
const TestSchema = z.object({
  provider: z.enum(['b2', 'minio']),
  b2: B2TestSchema.optional(),
  minio: MinioTestSchema.optional(),
});

function hint(s: string): string {
  if (s.length <= 4) return '****';
  return `…${s.slice(-4)}`;
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function createStorageSettingsRouter(deps: StorageSettingsRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ settings: null });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(storageSettings)
        .where(eq(storageSettings.firmId, session.firmId))
        .limit(1);
      if (!row) {
        // Surface the env-var fallback so the page can show what the
        // appliance is currently using even before the firm has saved.
        res.json({
          settings: null,
          envFallback: {
            provider: process.env['STORAGE_PROVIDER'] ?? 'mock',
            b2EndpointSet: Boolean(process.env['B2_ENDPOINT']),
            b2BucketSet: Boolean(process.env['B2_BUCKET']),
            minioEndpointSet: Boolean(process.env['MINIO_ENDPOINT']),
            minioBucketSet: Boolean(process.env['MINIO_BUCKET']),
          },
        });
        return;
      }
      res.json({
        settings: {
          provider: row.provider,
          b2: {
            endpoint: row.b2Endpoint,
            region: row.b2Region,
            bucket: row.b2Bucket,
            keyIdHint: row.b2KeyIdHint,
            applicationKeySet: row.b2ApplicationKeyEncrypted != null,
          },
          minio: {
            endpoint: row.minioEndpoint,
            region: row.minioRegion,
            bucket: row.minioBucket,
            accessKeyHint: row.minioAccessKeyHint,
            secretKeySet: row.minioSecretKeyEncrypted != null,
          },
          lastTestedAt: row.lastTestedAt,
          lastTestedProvider: row.lastTestedProvider,
          lastTestError: row.lastTestError,
          updatedAt: row.updatedAt,
        },
      });
    },
  );

  router.put(
    '/',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = PutSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const keyMgr = getFirmKeyManager(deps.db);

      // Pull the existing row so we can preserve secrets the admin
      // omitted (they typed a hint-masked field instead of re-pasting).
      const [existing] = await deps.db
        .select()
        .from(storageSettings)
        .where(eq(storageSettings.firmId, session.firmId))
        .limit(1);

      type SettingsValues = typeof storageSettings.$inferInsert;
      const values: SettingsValues = {
        firmId: session.firmId,
        provider: parsed.data.provider,
        updatedAt: new Date(),
        updatedById: session.appUserId,
      };

      if (parsed.data.b2) {
        const b = parsed.data.b2;
        values.b2Endpoint = b.endpoint;
        values.b2Region = b.region;
        values.b2Bucket = b.bucket;
        values.b2KeyIdEncrypted = keyMgr.wrapTDek(session.firmId, utf8(b.keyId));
        values.b2KeyIdHint = hint(b.keyId);
        if (b.applicationKey) {
          values.b2ApplicationKeyEncrypted = keyMgr.wrapTDek(
            session.firmId,
            utf8(b.applicationKey),
          );
        } else if (existing?.b2ApplicationKeyEncrypted) {
          values.b2ApplicationKeyEncrypted = existing.b2ApplicationKeyEncrypted;
        }
      }
      if (parsed.data.minio) {
        const m = parsed.data.minio;
        values.minioEndpoint = m.endpoint;
        values.minioRegion = m.region;
        values.minioBucket = m.bucket;
        values.minioAccessKeyEncrypted = keyMgr.wrapTDek(session.firmId, utf8(m.accessKey));
        values.minioAccessKeyHint = hint(m.accessKey);
        if (m.secretKey) {
          values.minioSecretKeyEncrypted = keyMgr.wrapTDek(session.firmId, utf8(m.secretKey));
        } else if (existing?.minioSecretKeyEncrypted) {
          values.minioSecretKeyEncrypted = existing.minioSecretKeyEncrypted;
        }
      }

      if (existing) {
        await deps.db
          .update(storageSettings)
          .set(values)
          .where(eq(storageSettings.firmId, session.firmId));
      } else {
        await deps.db.insert(storageSettings).values(values);
      }

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'firm_settings',
        entityId: session.firmId,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'storage_settings',
          provider: parsed.data.provider,
          b2BucketSet: Boolean(parsed.data.b2),
          minioBucketSet: Boolean(parsed.data.minio),
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.warn({ err }, 'storage settings audit failed'));

      res.json({ ok: true, restartRequired: true });
    },
  );

  router.post(
    '/test',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = TestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }

      // Resolve creds. When the admin re-tests without re-pasting the
      // secret, fall back to the stored encrypted value.
      const keyMgr = getFirmKeyManager(deps.db);
      const [existing] = await deps.db
        .select()
        .from(storageSettings)
        .where(eq(storageSettings.firmId, session.firmId))
        .limit(1);

      const start = Date.now();
      let client: B2StorageClient | null = null;
      try {
        if (parsed.data.provider === 'b2' && parsed.data.b2) {
          const b = parsed.data.b2;
          // Both the key id and the secret fall back to the sealed stored
          // value when the admin re-tests without re-pasting them.
          const keyId =
            b.keyId ||
            (existing?.b2KeyIdEncrypted
              ? fromUtf8(keyMgr.unwrapTDek(session.firmId, existing.b2KeyIdEncrypted))
              : '');
          if (!keyId) throw new Error('key_id_required');
          const secret =
            b.applicationKey ||
            (existing?.b2ApplicationKeyEncrypted
              ? fromUtf8(keyMgr.unwrapTDek(session.firmId, existing.b2ApplicationKeyEncrypted))
              : '');
          if (!secret) throw new Error('application_key_required');
          client = new B2StorageClient({
            endpoint: b.endpoint,
            region: b.region,
            bucket: b.bucket,
            accessKeyId: keyId,
            secretAccessKey: secret,
            forcePathStyle: true,
          });
        } else if (parsed.data.provider === 'minio' && parsed.data.minio) {
          const m = parsed.data.minio;
          const accessKey =
            m.accessKey ||
            (existing?.minioAccessKeyEncrypted
              ? fromUtf8(keyMgr.unwrapTDek(session.firmId, existing.minioAccessKeyEncrypted))
              : '');
          if (!accessKey) throw new Error('access_key_required');
          const secret =
            m.secretKey ||
            (existing?.minioSecretKeyEncrypted
              ? fromUtf8(keyMgr.unwrapTDek(session.firmId, existing.minioSecretKeyEncrypted))
              : '');
          if (!secret) throw new Error('secret_key_required');
          client = new B2StorageClient({
            endpoint: m.endpoint,
            region: m.region,
            bucket: m.bucket,
            accessKeyId: accessKey,
            secretAccessKey: secret,
            forcePathStyle: true,
          });
        } else {
          res.status(400).json({ error: 'invalid_provider_for_test' });
          return;
        }

        // Roundtrip: list (proves auth), put + delete a temp object
        // under a sentinel prefix that won't collide with real files.
        const probeKey = `_vibe_health/test-${Date.now()}.txt`;
        const probeBody = Buffer.from(
          `vibe storage health check ${new Date().toISOString()}`,
          'utf8',
        );
        // list returns AsyncIterable — drain a few entries to prove auth + paging.
        const it = client.list('_vibe_health/');
        let drained = 0;
        for await (const _ of it) {
          drained += 1;
          if (drained >= 5) break;
        }
        await client.put(probeKey, probeBody, { contentType: 'text/plain' });
        await client.delete(probeKey);

        const latencyMs = Date.now() - start;
        await deps.db
          .update(storageSettings)
          .set({
            lastTestedAt: new Date(),
            lastTestedProvider: parsed.data.provider,
            lastTestError: null,
          })
          .where(eq(storageSettings.firmId, session.firmId))
          .catch(() => undefined);
        res.json({ ok: true, latencyMs });
      } catch (err) {
        let msg = err instanceof Error ? err.message : String(err);
        // The AWS S3 client parses response bodies as XML. A JSON body
        // (first char '{') means the endpoint is not the S3-compatible
        // host — almost always B2's native JSON API was entered instead
        // of s3.<region>.backblazeb2.com. Translate the opaque parser
        // error into an actionable hint.
        if (/is not expected|Deserialization error/i.test(msg)) {
          msg =
            'The storage endpoint returned a non-S3 (JSON) response. ' +
            'Check that the endpoint is the S3-compatible host ' +
            '(e.g. https://s3.<region>.backblazeb2.com), not the native B2 API. ' +
            `(raw: ${msg.slice(0, 200)})`;
        }
        // Persist the error so the GET surface can show "last test
        // failed at … because …" even after the admin walks away.
        await deps.db
          .update(storageSettings)
          .set({
            lastTestedAt: new Date(),
            lastTestedProvider: parsed.data.provider,
            lastTestError: msg.slice(0, 1000),
          })
          .where(eq(storageSettings.firmId, session.firmId))
          .catch(() => undefined);
        logger.warn({ err, firmId: session.firmId }, 'storage test failed');
        res.status(400).json({ ok: false, error: msg });
      }
    },
  );

  return router;
}
