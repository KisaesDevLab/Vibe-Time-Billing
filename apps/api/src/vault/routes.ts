// SPDX-License-Identifier: Elastic-2.0
//
// 0159 — Per-client credential vault routes (mounted under
// /api/staff/clients/:id/credentials).
//
//   GET    /                 list metadata only (never ciphertext/plaintext)
//   POST   /                 store a credential (encrypted under a per-record DEK)
//   PATCH  /:credId          update metadata and/or re-encrypt changed secrets
//   POST   /:credId/reveal   decrypt + return plaintext — requires a fresh
//                            step-up; audited
//   DELETE /:credId          archive (soft delete)
//
// Secrets are encrypted at rest with a per-record DEK wrapped by the firm MFK
// (see ./crypto). Reveal is gated by `client:credential:read` + a fresh TOTP
// step-up + an append-only audit row. Reads/writes are firm-scoped.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientCredentials, clients } from '@vibe/db/schema';
import { isStepUpFresh } from '@vibe/core/auth';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { isSecondFactorRequired } from '../auth/second-factor-policy';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { loadConfig } from '../config';
import { newCredentialKey, unwrapCredentialKey, encField, decField } from './crypto';

export interface VaultRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CATEGORIES = ['irs', 'state', 'bank', 'payroll', 'software', 'other'] as const;

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(CATEGORIES).default('other'),
  username: z.string().max(500).optional().nullable(),
  password: z.string().max(4000).optional().nullable(),
  url: z.string().max(2000).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
});

const UpdateSchema = CreateSchema.partial();

/** Plaintext username last-4-ish hint for list preview (never the secret). */
function usernameHint(username: string | null | undefined): string | null {
  if (!username) return null;
  const at = username.indexOf('@');
  if (at > 1) return `${username.slice(0, 1)}***${username.slice(at)}`;
  return username.length <= 3 ? username : `${username.slice(0, 2)}***`;
}

export function createClientCredentialRouter(deps: VaultRoutesDeps): Router {
  const router = express.Router({ mergeParams: true });
  addUuidIdGuard(router, ['id', 'credId']);

  // Confirm the :id client belongs to the caller's firm.
  async function loadClient(req: Request): Promise<{ id: string } | null> {
    if (!deps.db) return null;
    const firmId = req.staffSession!.firmId;
    const [row] = await deps.db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
      .limit(1);
    return row ?? null;
  }

  // List — metadata only.
  router.get(
    '/',
    requirePermission(deps, 'client:credential:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const client = await loadClient(req);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select({
          id: clientCredentials.id,
          title: clientCredentials.title,
          category: clientCredentials.category,
          hint: clientCredentials.hint,
          hasPassword: clientCredentials.passwordEnc,
          url: clientCredentials.urlEnc, // presence only; mapped below
          lastRevealedAt: clientCredentials.lastRevealedAt,
          createdAt: clientCredentials.createdAt,
          updatedAt: clientCredentials.updatedAt,
        })
        .from(clientCredentials)
        .where(
          and(eq(clientCredentials.clientId, client.id), eq(clientCredentials.status, 'ACTIVE')),
        )
        .orderBy(desc(clientCredentials.createdAt))
        .limit(500);
      res.json({
        items: items.map((c) => ({
          id: c.id,
          title: c.title,
          category: c.category,
          hint: c.hint,
          hasPassword: c.hasPassword != null,
          hasUrl: c.url != null,
          lastRevealedAt: c.lastRevealedAt,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      });
    },
  );

  // Create.
  router.post(
    '/',
    requirePermission(deps, 'client:credential:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const session = req.staffSession!;
      const client = await loadClient(req);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      const d = parsed.data;
      let row;
      try {
        const { dek, wrappedDek } = newCredentialKey(deps.db, session.firmId);
        [row] = await deps.db
          .insert(clientCredentials)
          .values({
            firmId: session.firmId,
            clientId: client.id,
            title: d.title,
            category: d.category,
            hint: usernameHint(d.username),
            wrappedDek,
            usernameEnc: encField(dek, d.username),
            passwordEnc: encField(dek, d.password),
            urlEnc: encField(dek, d.url),
            notesEnc: encField(dek, d.notes),
            createdBy: session.appUserId,
          })
          .returning({ id: clientCredentials.id });
        dek.fill(0);
      } catch {
        res.status(503).json({ error: 'vault_unavailable' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_credential',
        entityId: row!.id,
        actorAppUserId: session.appUserId,
        activeClientId: client.id,
        after: { title: d.title, category: d.category }, // never secrets
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.status(201).json({ id: row!.id });
    },
  );

  // Update — metadata and/or rotate secret fields.
  router.patch(
    '/:credId',
    requirePermission(deps, 'client:credential:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const session = req.staffSession!;
      const client = await loadClient(req);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      const [cred] = await deps.db
        .select()
        .from(clientCredentials)
        .where(
          and(
            eq(clientCredentials.id, req.params['credId']!),
            eq(clientCredentials.clientId, client.id),
            eq(clientCredentials.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!cred) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const d = parsed.data;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (d.title !== undefined) patch['title'] = d.title;
      if (d.category !== undefined) patch['category'] = d.category;
      // Re-encrypt any provided secret field under the existing record DEK.
      const secretKeys: Array<'username' | 'password' | 'url' | 'notes'> = [
        'username',
        'password',
        'url',
        'notes',
      ];
      const touchesSecret = secretKeys.some((k) => d[k] !== undefined);
      if (touchesSecret) {
        try {
          const dek = unwrapCredentialKey(deps.db, session.firmId, cred.wrappedDek);
          if (d.username !== undefined) {
            patch['usernameEnc'] = encField(dek, d.username);
            patch['hint'] = usernameHint(d.username);
          }
          if (d.password !== undefined) patch['passwordEnc'] = encField(dek, d.password);
          if (d.url !== undefined) patch['urlEnc'] = encField(dek, d.url);
          if (d.notes !== undefined) patch['notesEnc'] = encField(dek, d.notes);
          dek.fill(0);
        } catch {
          res.status(503).json({ error: 'vault_unavailable' });
          return;
        }
      }
      await deps.db.update(clientCredentials).set(patch).where(eq(clientCredentials.id, cred.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_credential',
        entityId: cred.id,
        actorAppUserId: session.appUserId,
        activeClientId: client.id,
        after: { fields: Object.keys(d) }, // field names only, never values
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // Reveal — the sensitive path: fresh step-up required, decrypt, audit.
  router.post(
    '/:credId/reveal',
    requirePermission(deps, 'client:credential:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const session = req.staffSession!;
      // Step-up freshness (the actual TOTP verification + lockout live at the
      // Account step-up endpoint). Honor the firm's second-factor toggle.
      const fresh = isStepUpFresh(session, loadConfig().STEP_UP_TIMEOUT_MINUTES);
      if (!fresh && (await isSecondFactorRequired(deps.db, session.firmId))) {
        res.status(403).json({ error: 'step_up_required' });
        return;
      }
      const client = await loadClient(req);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [cred] = await deps.db
        .select()
        .from(clientCredentials)
        .where(
          and(
            eq(clientCredentials.id, req.params['credId']!),
            eq(clientCredentials.clientId, client.id),
            eq(clientCredentials.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!cred) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      let secret;
      try {
        const dek = unwrapCredentialKey(deps.db, session.firmId, cred.wrappedDek);
        secret = {
          username: decField(dek, cred.usernameEnc),
          password: decField(dek, cred.passwordEnc),
          url: decField(dek, cred.urlEnc),
          notes: decField(dek, cred.notesEnc),
        };
        dek.fill(0);
      } catch {
        // Firm key locked or ciphertext unreadable.
        res.status(503).json({ error: 'vault_unavailable' });
        return;
      }
      await deps.db
        .update(clientCredentials)
        .set({ lastRevealedAt: new Date(), lastRevealedBy: session.appUserId })
        .where(eq(clientCredentials.id, cred.id));
      await emitAudit(deps.db, {
        action: 'STEP_UP',
        entityType: 'client_credential',
        entityId: cred.id,
        actorAppUserId: session.appUserId,
        activeClientId: client.id,
        after: { revealed: true, category: cred.category }, // never the secret
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json(secret);
    },
  );

  // Archive (soft delete).
  router.delete(
    '/:credId',
    requirePermission(deps, 'client:credential:delete'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const session = req.staffSession!;
      const client = await loadClient(req);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [cred] = await deps.db
        .select({ id: clientCredentials.id })
        .from(clientCredentials)
        .where(
          and(
            eq(clientCredentials.id, req.params['credId']!),
            eq(clientCredentials.clientId, client.id),
            eq(clientCredentials.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!cred) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(clientCredentials)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(eq(clientCredentials.id, cred.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_credential',
        entityId: cred.id,
        actorAppUserId: session.appUserId,
        activeClientId: client.id,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
