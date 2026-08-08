// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Portal-realm AI support chat. Mounted at /api/portal/ai under the portal
// auth middleware (distinct cookie/signing key — cross-realm isolation
// holds). Reuses the shared runKbChat, but restricts KB retrieval to
// client-visible articles (audience client/both) so internal staff content
// never reaches a client. Budget + egress policy are the firm's, identical
// to the staff path; the request is logged with a null app-user actor.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

import { PORTAL_AUDIENCES } from '../help/queries';
import { kbChatAvailable, runKbChat, sendKbChat, type AiRoutesDeps } from './routes';

export interface PortalAiRoutesDeps extends AiRoutesDeps {
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

const PortalChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(12),
  maxTokens: z.number().int().min(64).max(2000).optional(),
});

export function createPortalAiRouter(deps: PortalAiRoutesDeps): Router {
  const router = express.Router();

  // GET /status — the portal SPA hides the chat when AI isn't usable.
  router.get('/status', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const enabled = await kbChatAvailable(deps, session.firmId);
    res.json({ enabled });
  });

  // POST /chat — KB-grounded answer, restricted to client-visible articles.
  router.post('/chat', deps.requireAuth, async (req: Request, res: Response) => {
    const parsed = PortalChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.portalSession!;
    const out = await runKbChat(deps, {
      firmId: session.firmId,
      messages: parsed.data.messages,
      maxTokens: parsed.data.maxTokens,
      audiences: PORTAL_AUDIENCES,
      actorAppUserId: null,
      feature: 'support_chat_portal',
      // A1 — router cost attribution: the session's active client entity
      // (session-validated FK). Never enters the prompt.
      clientId: session.activeClientId,
    });
    sendKbChat(res, out);
  });

  return router;
}
