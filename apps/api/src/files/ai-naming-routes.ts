// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — bulk "AI rename" for the client Files tab. Mounted on the
// /api/staff/clients router next to file-manage. All routes 404 when the
// effective AI mode is not the router: in direct mode the feature does
// not exist (the UI hides it via /api/staff/ai/status).
//
//   POST /:id/files/ai-rename/suggest          { fileIds ≤ 25 }
//   POST /:id/files/ai-rename/apply            { items: [{fileId, newFilename, confidence?}] }
//   POST /:id/files/:fileId/ai-rename/revert
//   POST /:id/files/:fileId/ai-rename/apply-suggested

import { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

import { getAiRuntime } from '../ai/ai-runtime';
import { requirePermission } from '../auth/rbac-middleware';
import {
  applyAiRename,
  applySuggestedName,
  revertAiRename,
  suggestFileName,
  type AiNamingDeps,
} from './ai-naming';

export const AI_RENAME_MAX_FILES = 25;
const SUGGEST_CONCURRENCY = 3;

const SuggestSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(AI_RENAME_MAX_FILES),
});
const ApplySchema = z.object({
  items: z
    .array(
      z.object({
        fileId: z.string().uuid(),
        newFilename: z.string().min(1).max(255),
        confidence: z.number().min(0).max(1).optional(),
        model: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(AI_RENAME_MAX_FILES),
});

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function routerOnly(res: Response): boolean {
  if (getAiRuntime().mode !== 'router') {
    res.status(404).json({ error: 'ai_file_naming_unavailable' });
    return false;
  }
  return true;
}

export function mountAiNamingRoutes(router: Router, deps: AiNamingDeps): void {
  router.post(
    '/:id/files/ai-rename/suggest',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      if (!routerOnly(res)) return;
      const parsed = SuggestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      const clientId = req.params['id']!;
      const items = await runWithConcurrency(
        [...new Set(parsed.data.fileIds)],
        SUGGEST_CONCURRENCY,
        async (fileId) => {
          return suggestFileName(deps, {
            firmId: session.firmId,
            clientId,
            fileId,
            actorId: session.appUserId,
            mode: 'bulk',
          });
        },
      );
      res.json({
        items: items.map((r) =>
          r.ok
            ? {
                fileId: r.fileId,
                current: r.current,
                proposed: r.proposed,
                confidence: r.confidence,
                fields: r.fields,
                strategy: r.strategy,
                summary: r.summary,
                model: r.model,
              }
            : { fileId: r.fileId, current: r.current ?? null, skippedReason: r.skippedReason },
        ),
      });
    },
  );

  router.post(
    '/:id/files/ai-rename/apply',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      if (!routerOnly(res)) return;
      const parsed = ApplySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      const renamed: Array<{ fileId: string; originalFilename: string }> = [];
      const skipped: Array<{ fileId: string; code: string }> = [];
      for (const item of parsed.data.items) {
        const r = await applyAiRename(deps, {
          firmId: session.firmId,
          clientId: req.params['id']!,
          fileId: item.fileId,
          newFilename: item.newFilename,
          actorId: session.appUserId,
          confidence: item.confidence ?? null,
          model: item.model ?? null,
        });
        if (r.ok) renamed.push({ fileId: item.fileId, originalFilename: r.originalFilename });
        else skipped.push({ fileId: item.fileId, code: r.code });
      }
      res.json({ renamed, skipped });
    },
  );

  router.post(
    '/:id/files/:fileId/ai-rename/revert',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      if (!routerOnly(res)) return;
      const session = req.staffSession!;
      const r = await revertAiRename(deps, {
        firmId: session.firmId,
        clientId: req.params['id']!,
        fileId: req.params['fileId']!,
        actorId: session.appUserId,
      });
      if (!r.ok) {
        res.status(r.status).json({ error: r.code });
        return;
      }
      res.json({ ok: true, originalFilename: r.originalFilename });
    },
  );

  router.post(
    '/:id/files/:fileId/ai-rename/apply-suggested',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      if (!routerOnly(res)) return;
      const session = req.staffSession!;
      const r = await applySuggestedName(deps, {
        firmId: session.firmId,
        clientId: req.params['id']!,
        fileId: req.params['fileId']!,
        actorId: session.appUserId,
      });
      if (!r.ok) {
        res.status(r.status).json({ error: r.code });
        return;
      }
      res.json({ ok: true, originalFilename: r.originalFilename });
    },
  );
}
