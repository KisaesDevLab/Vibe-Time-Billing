// SPDX-License-Identifier: Elastic-2.0
//
// Capture Client Info — the intake endpoint. Accepts a base64 PNG of an
// UltraTax General Information screen, OCRs it on the firm's local GLM-OCR
// server, and returns the extracted fields plus a mapping into the client
// form. It never writes a client: the staff review-and-confirm step drives
// the existing POST /clients + PATCH :id + POST :id/contacts flow.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { aiRequestLog } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import type { OcrClient } from './glm-client';
import { mapExtractedToClient } from './map-to-client';

export interface OcrRoutesDeps extends RbacDeps {
  db: Database | null;
  /** Bound in server.ts when GLM_OCR_URL is set; null disables the surface. */
  ocr?: OcrClient | null;
}

const IntakeSchema = z.object({
  // base64 PNG WITHOUT the data: prefix (the client strips it).
  imageBase64: z.string().min(1).max(20_000_000),
});

function clientIp(req: Request): string {
  const fwd = req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.ip ?? '';
}

export function createOcrRouter(deps: OcrRoutesDeps): Router {
  const router = express.Router();

  router.post(
    '/client-intake',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const ocr = deps.ocr;
      if (!ocr) {
        res.status(503).json({ error: 'ocr_not_configured' });
        return;
      }
      const parsed = IntakeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      const startedAt = Date.now();
      try {
        const result = await ocr.extract(parsed.data.imageBase64);
        const mapped = mapExtractedToClient(result.extracted);
        const latencyMs = Date.now() - startedAt;

        // Usage/audit trail. The audit `after` is deliberately PII-free —
        // only the detected form type and latency, never names or addresses.
        void logIntake(deps.db, {
          firmId: session.firmId,
          appUserId: session.appUserId,
          model: ocr.model,
          latencyMs,
          success: true,
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
        });
        void emitAudit(deps.db, {
          action: 'AI_REQUEST',
          entityType: 'client',
          actorAppUserId: session.appUserId,
          after: {
            feature: 'client_intake_ocr',
            entityForm: result.extracted.entityForm,
            latencyMs,
          },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

        res.status(200).json({ extracted: result.extracted, mapped });
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        logger.warn({ err }, 'client-intake ocr failed');
        void logIntake(deps.db, {
          firmId: session.firmId,
          appUserId: session.appUserId,
          model: ocr.model,
          latencyMs,
          success: false,
          errorMessage: err instanceof Error ? err.message : 'ocr_failed',
          inputTokens: null,
          outputTokens: null,
        });
        res.status(502).json({ error: 'ocr_failed' });
      }
    },
  );

  return router;
}

interface IntakeLog {
  firmId: string;
  appUserId: string;
  model: string;
  latencyMs: number;
  success: boolean;
  errorMessage?: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

// Mirrors ai/routes.ts logAiRequest (which isn't exported): one row per OCR
// call so the firm's AI dashboard counts intake usage.
function logIntake(db: Database | null, args: IntakeLog): Promise<void> {
  if (!db) return Promise.resolve();
  return db
    .insert(aiRequestLog)
    .values({
      firmId: args.firmId,
      provider: 'OPENAI_COMPATIBLE',
      model: args.model,
      feature: 'client_intake_ocr',
      requestTokens: args.inputTokens,
      responseTokens: args.outputTokens,
      latencyMs: args.latencyMs,
      success: args.success,
      errorMessage: args.errorMessage ?? null,
      appUserId: args.appUserId,
    })
    .then(() => undefined)
    .catch((err: unknown) => logger.error({ err }, 'ai log failed'));
}
