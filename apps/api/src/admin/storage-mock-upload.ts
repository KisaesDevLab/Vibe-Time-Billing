// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Dev-only translator for mock-presign:// upload URLs (Phase 10 of
// FILE_MANAGER_ADDENDUM.md). When STORAGE_PROVIDER=mock, the
// MockStorageClient hands out opaque `mock-presign://put/...` URLs
// that the browser can't fetch directly. The FE detects these and
// POSTs the URL + body here; we decode the URL, validate the
// expires_at stamp, and call storage.put() against the mock client.
//
// In production (STORAGE_PROVIDER=b2) the FE PUTs directly to the
// presigned HTTPS URL and never hits this route.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

import { buildStorageClient, parseMockPresignUrl, type StorageClient } from '@vibe/storage';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface StorageMockUploadDeps extends RbacDeps {
  storageClient?: StorageClient;
}

const PayloadSchema = z.object({
  url: z.string().min(1).max(2048),
  contentBase64: z.string().min(1),
  contentType: z.string().max(200).optional(),
});

function getStorage(deps: StorageMockUploadDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

export function createStorageMockUploadRouter(deps: StorageMockUploadDeps): Router {
  const router = express.Router();

  router.post(
    '/upload-mock',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = PayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const storage = getStorage(deps);
      if (!storage || storage.kind !== 'mock') {
        // Production B2 should never hit this — the FE only uses it for
        // mock-presign URLs. Refuse explicitly so a misconfigured deploy
        // doesn't silently corrupt object storage.
        res.status(409).json({ error: 'not_mock_storage' });
        return;
      }
      const url = parseMockPresignUrl(parsed.data.url);
      if (!url || url.kind !== 'put') {
        res.status(400).json({ error: 'invalid_mock_presign_url' });
        return;
      }
      if (Date.now() > url.expiresAt) {
        res.status(410).json({ error: 'presign_expired' });
        return;
      }
      let body: Buffer;
      try {
        body = Buffer.from(parsed.data.contentBase64, 'base64');
      } catch {
        res.status(400).json({ error: 'invalid_content_base64' });
        return;
      }
      const { etag } = await storage.put(url.key, body, {
        contentType: parsed.data.contentType ?? 'application/octet-stream',
      });
      res.json({ ok: true, etag, sizeBytes: body.byteLength });
    },
  );

  return router;
}
