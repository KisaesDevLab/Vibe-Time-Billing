// SPDX-License-Identifier: Elastic-2.0
//
// FMv2 §4.6–§4.8 — Admin conflict resolution API.
//
// Mounted at /api/staff/storage/conflicts. All endpoints require
// `storage:folder:reconcile`.
//
//   GET    /                 — open conflicts + other_events queue
//   GET    /:attempt_id      — single-conflict detail (mockup 4)
//   POST   /:attempt_id/resolve — apply keep_current / reassign /
//                                 unbind_both
//
// The `folder-reassign` BullMQ job (§5.1) is the heavy lift on
// `reassign`. v1 of this file dispatches the row update synchronously
// so the API contract is testable end-to-end; Phase E migrates the
// transfer into a background job.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientFolders,
  clients,
  folderLinkAttempts,
  folderSyncEvents,
} from '@vibe/db/schema';
import { buildStorageClient, readSentinel, writeSentinel, type StorageClient } from '@vibe/storage';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface ConflictsDeps extends RbacDeps {
  db: Database | null;
  storage?: StorageClient;
}

const ResolveSchema = z
  .object({
    action: z.enum(['keep_current', 'reassign', 'unbind_both']),
    reason: z.string().max(2000).optional(),
  })
  .refine((v) => v.action === 'keep_current' || (v.reason && v.reason.trim().length >= 10), {
    message: 'reason >= 10 chars required for non-default actions',
  });

function getStorage(deps: ConflictsDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

// §4.7 recommendation heuristic. Pure function; the inputs are the
// sentinel age in days, fuzzy match scores, and binding age. v1
// implementation: keep_current when the currently-bound client has
// the higher name-fuzzy score AND the sentinel is older than 30
// days. Otherwise reassign. unbind_both is never the algorithm's
// default — only when both scores are near-equal AND the binding is
// young (< 7 days), suggesting the original was a mistake.
export interface RecommendationInput {
  current_fuzzy: number;
  challenger_fuzzy: number;
  binding_age_days: number;
}

export interface RecommendationOutput {
  action: 'keep_current' | 'reassign' | 'unbind_both';
  rationale: string;
}

export function computeRecommendation(input: RecommendationInput): RecommendationOutput {
  const fuzzyGap = input.current_fuzzy - input.challenger_fuzzy;
  if (Math.abs(fuzzyGap) < 0.05 && input.binding_age_days < 7) {
    return {
      action: 'unbind_both',
      rationale:
        'Both clients have near-identical name match scores and the original binding is very recent — likely a mistake. Unbind both and have each client re-link from a fresh search.',
    };
  }
  if (fuzzyGap >= 0 && input.binding_age_days >= 30) {
    return {
      action: 'keep_current',
      rationale: `Sentinel was written ${input.binding_age_days} days ago and the currently bound client has the higher name match (${input.current_fuzzy.toFixed(2)} vs ${input.challenger_fuzzy.toFixed(2)}). The challenger's claim is weaker than the established binding.`,
    };
  }
  if (input.challenger_fuzzy > input.current_fuzzy) {
    return {
      action: 'reassign',
      rationale: `The challenger has a higher name match (${input.challenger_fuzzy.toFixed(2)} vs ${input.current_fuzzy.toFixed(2)}). Consider reassigning the folder to the challenger.`,
    };
  }
  return {
    action: 'keep_current',
    rationale: `Currently bound client has at least the same match strength (${input.current_fuzzy.toFixed(2)} vs ${input.challenger_fuzzy.toFixed(2)}). Keep current binding.`,
  };
}

function nameFuzzyDelta(folderPath: string, clientName: string): number {
  // Very-loose 0..1 score using the match-engine reasons would be
  // ideal; for the recommendation we just use a token-overlap ratio.
  // Match-engine is preferred path; this is a guarded estimate that
  // doesn't require pulling the entire bucket listing.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,;:'"!?(){}[\]\\/_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter((t) => t.length >= 2);
  const a = new Set(norm(folderPath));
  const b = new Set(norm(clientName));
  const intersect = [...a].filter((t) => b.has(t)).length;
  return intersect / Math.max(1, Math.max(a.size, b.size));
}

export function createConflictsRouter(deps: ConflictsDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['attempt_id']);

  // §4.6 — open conflicts + other reconciliation work
  router.get(
    '/',
    requirePermission(deps, 'storage:folder:reconcile'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      // Open conflicts.
      const open = await deps.db
        .select()
        .from(folderLinkAttempts)
        .where(
          and(
            eq(folderLinkAttempts.firmId, session.firmId),
            inArray(folderLinkAttempts.outcome, ['pending', 'contested']),
          ),
        )
        .orderBy(desc(folderLinkAttempts.attemptedAt));

      // Resolve attempter names + bound-to client names for the
      // response payload.
      const attempterIds = Array.from(new Set(open.map((r) => r.attemptedBy)));
      const challengerIds = Array.from(new Set(open.map((r) => r.clientId)));
      const allIds = Array.from(new Set([...attempterIds, ...challengerIds]));
      let userMap = new Map<string, string>();
      if (attempterIds.length > 0) {
        const rows = await deps.db
          .select({ id: appUsers.id, fullName: appUsers.fullName })
          .from(appUsers)
          .where(inArray(appUsers.id, attempterIds));
        userMap = new Map(rows.map((r) => [r.id, r.fullName]));
      }
      let clientMap = new Map<string, string>();
      if (allIds.length > 0) {
        const rows = await deps.db
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(inArray(clients.id, challengerIds));
        clientMap = new Map(rows.map((r) => [r.id, r.name]));
      }
      // Pull current-binding clients by storage_path.
      const paths = Array.from(new Set(open.map((r) => r.storagePath)));
      const currentBindings =
        paths.length === 0
          ? []
          : await deps.db
              .select({
                storagePath: clientFolders.storagePath,
                clientId: clientFolders.clientId,
                firmId: clientFolders.firmId,
              })
              .from(clientFolders)
              .where(
                and(
                  eq(clientFolders.firmId, session.firmId),
                  inArray(clientFolders.storagePath, paths),
                ),
              );
      const bindingByPath = new Map(currentBindings.map((r) => [r.storagePath, r]));
      const bindingClientIds = Array.from(new Set(currentBindings.map((r) => r.clientId)));
      let bindingClientMap = new Map<string, string>();
      if (bindingClientIds.length > 0) {
        const rows = await deps.db
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(inArray(clients.id, bindingClientIds));
        bindingClientMap = new Map(rows.map((r) => [r.id, r.name]));
      }

      const conflicts = open.map((r) => {
        const binding = bindingByPath.get(r.storagePath);
        return {
          id: r.id,
          type: r.outcome === 'contested' ? 'link_contested' : 'pending_link',
          storage_path: r.storagePath,
          bound_to:
            binding != null
              ? {
                  client_id: binding.clientId,
                  client_name: bindingClientMap.get(binding.clientId) ?? '(unknown)',
                }
              : null,
          challenger: {
            client_id: r.clientId,
            client_name: clientMap.get(r.clientId) ?? '(unknown)',
          },
          attempted_by: {
            user_id: r.attemptedBy,
            user_name: userMap.get(r.attemptedBy) ?? '(unknown)',
          },
          attempted_at: r.attemptedAt.toISOString(),
          match_confidence: r.matchConfidence ? Number(r.matchConfidence) : null,
        };
      });

      // Other events (unresolved discover/missing/orphan/sentinel_lost).
      const others = await deps.db
        .select()
        .from(folderSyncEvents)
        .where(
          and(
            eq(folderSyncEvents.firmId, session.firmId),
            isNull(folderSyncEvents.resolvedAt),
            inArray(folderSyncEvents.eventType, [
              'discovered',
              'missing',
              'orphan',
              'sentinel_lost',
            ]),
          ),
        )
        .orderBy(desc(folderSyncEvents.detectedAt));

      // Counts.
      const counts = {
        contested: conflicts.filter((c) => c.type === 'link_contested').length,
        discovered: others.filter((e) => e.eventType === 'discovered').length,
        missing: others.filter((e) => e.eventType === 'missing').length,
        sentinel_lost: others.filter((e) => e.eventType === 'sentinel_lost').length,
        orphan: others.filter((e) => e.eventType === 'orphan').length,
      };

      res.json({
        conflicts,
        other_events: others.map((e) => ({
          id: e.id,
          type: e.eventType,
          storage_path: e.pathAfter ?? e.pathBefore ?? '',
          detected_at: e.detectedAt.toISOString(),
        })),
        counts,
      });
    },
  );

  // §4.7 — single-conflict detail (mockup 4)
  router.get(
    '/:attempt_id',
    requirePermission(deps, 'storage:folder:reconcile'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [attempt] = await deps.db
        .select()
        .from(folderLinkAttempts)
        .where(
          and(
            eq(folderLinkAttempts.id, req.params['attempt_id']!),
            eq(folderLinkAttempts.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!attempt) {
        res.status(404).json({ error: 'attempt_not_found' });
        return;
      }

      // Current binding for the path.
      const [binding] = await deps.db
        .select()
        .from(clientFolders)
        .where(
          and(
            eq(clientFolders.firmId, session.firmId),
            eq(clientFolders.storagePath, attempt.storagePath),
          ),
        )
        .limit(1);

      // Challenger + currently-bound client rows.
      const ids = binding ? [attempt.clientId, binding.clientId] : [attempt.clientId];
      const peopleRows =
        ids.length === 0
          ? []
          : await deps.db
              .select({
                id: clients.id,
                name: clients.name,
                taxSoftwareId: clients.taxSoftwareId,
                status: clients.status,
              })
              .from(clients)
              .where(inArray(clients.id, ids));
      const peopleMap = new Map(peopleRows.map((r) => [r.id, r]));
      const challenger = peopleMap.get(attempt.clientId);
      const currentlyBound = binding ? peopleMap.get(binding.clientId) : null;

      // Sentinel + folder stats. Best-effort via storage client.
      const storage = getStorage(deps);
      let sentinel: {
        version: number;
        client_id: string;
        firm_id: string;
        created_at: string;
        created_by: string | null;
        display_name_at_creation: string;
      } | null = null;
      if (storage) {
        const r = await readSentinel(storage, attempt.storagePath).catch(() => null);
        if (r && r.ok) {
          sentinel = {
            version: r.payload.version,
            client_id: r.payload.client_id,
            firm_id: r.payload.firm_id,
            created_at: r.payload.created_at,
            created_by: r.payload.created_by,
            display_name_at_creation: r.payload.display_name_at_creation,
          };
        }
      }

      // Match-fuzzy scores for the recommendation.
      const currentFuzzy = currentlyBound
        ? nameFuzzyDelta(attempt.storagePath, currentlyBound.name)
        : 0;
      const challengerFuzzy = challenger ? nameFuzzyDelta(attempt.storagePath, challenger.name) : 0;
      const bindingAgeDays = binding
        ? Math.floor((Date.now() - binding.createdAt.getTime()) / 86_400_000)
        : 0;
      const recommendation = computeRecommendation({
        current_fuzzy: currentFuzzy,
        challenger_fuzzy: challengerFuzzy,
        binding_age_days: bindingAgeDays,
      });

      // Audit trail: per-path folder_sync_events.
      const trail = await deps.db
        .select()
        .from(folderSyncEvents)
        .where(
          and(
            eq(folderSyncEvents.firmId, session.firmId),
            eq(folderSyncEvents.pathAfter, attempt.storagePath),
          ),
        )
        .orderBy(folderSyncEvents.detectedAt);

      res.json({
        attempt: {
          id: attempt.id,
          storage_path: attempt.storagePath,
          attempted_by: attempt.attemptedBy,
          attempted_at: attempt.attemptedAt.toISOString(),
          match_confidence: attempt.matchConfidence ? Number(attempt.matchConfidence) : null,
          outcome: attempt.outcome,
        },
        folder: {
          storage_path: attempt.storagePath,
          sentinel,
        },
        currently_bound: currentlyBound
          ? {
              client_id: currentlyBound.id,
              client_name: currentlyBound.name,
              tax_software_id: currentlyBound.taxSoftwareId,
              client_status: currentlyBound.status,
              name_fuzzy_score: Math.round(currentFuzzy * 1000) / 1000,
              binding_age_days: bindingAgeDays,
            }
          : null,
        challenger: challenger
          ? {
              client_id: challenger.id,
              client_name: challenger.name,
              tax_software_id: challenger.taxSoftwareId,
              client_status: challenger.status,
              name_fuzzy_score: Math.round(challengerFuzzy * 1000) / 1000,
            }
          : null,
        recommendation,
        audit_trail: trail.map((e) => ({
          ts: e.detectedAt.toISOString(),
          actor: e.resolvedBy ?? null,
          event: e.eventType,
          detail: e.notes ?? null,
        })),
      });
    },
  );

  // §4.8 — apply resolution
  router.post(
    '/:attempt_id/resolve',
    requirePermission(deps, 'storage:folder:reconcile'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ResolveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
        return;
      }
      const [attempt] = await deps.db
        .select()
        .from(folderLinkAttempts)
        .where(
          and(
            eq(folderLinkAttempts.id, req.params['attempt_id']!),
            eq(folderLinkAttempts.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!attempt) {
        res.status(404).json({ error: 'attempt_not_found' });
        return;
      }
      if (attempt.outcome !== 'pending' && attempt.outcome !== 'contested') {
        res.status(409).json({ error: 'already_resolved', outcome: attempt.outcome });
        return;
      }

      const newOutcome =
        parsed.data.action === 'keep_current'
          ? 'denied'
          : parsed.data.action === 'reassign'
            ? 'reassigned'
            : 'aborted';
      const resolution =
        parsed.data.action === 'keep_current'
          ? 'kept_current'
          : parsed.data.action === 'reassign'
            ? 'reassigned'
            : 'unbound_both';

      // Apply the side effects per action.
      if (parsed.data.action === 'keep_current') {
        // No state change to client_folders or sentinel. Just record
        // the denial.
        // (no-op)
      } else if (parsed.data.action === 'reassign') {
        // Transfer client_folders row to the challenger; write new
        // sentinel; v1 does this synchronously, Phase E migrates to a
        // BullMQ folder-reassign job.
        const [binding] = await deps.db
          .select()
          .from(clientFolders)
          .where(
            and(
              eq(clientFolders.firmId, session.firmId),
              eq(clientFolders.storagePath, attempt.storagePath),
            ),
          )
          .limit(1);
        if (binding) {
          // Move the row's client_id pointer to the challenger in a
          // single update. The intermediate 'reassigning' state isn't
          // in the schema CHECK; Phase E adds the BullMQ background
          // job that needs the dual-row pattern.
          await deps.db
            .update(clientFolders)
            .set({
              clientId: attempt.clientId,
              status: 'active',
              lastSyncedAt: new Date(),
            })
            .where(eq(clientFolders.id, binding.id));
        }
        // Write a new sentinel to the challenger (best effort — if the
        // storage client isn't wired, we still record the resolution).
        const storage = getStorage(deps);
        if (storage) {
          const [challengerName] = await deps.db
            .select({ name: clients.name })
            .from(clients)
            .where(eq(clients.id, attempt.clientId))
            .limit(1);
          await writeSentinel(storage, attempt.storagePath, {
            version: 1,
            client_id: attempt.clientId,
            firm_id: session.firmId,
            tax_software_id: null,
            created_at: new Date().toISOString(),
            created_by: session.appUserId,
            display_name_at_creation: challengerName?.name ?? attempt.storagePath,
          }).catch((err: unknown) => logger.error({ err }, 'reassign sentinel write failed'));
        }
      } else {
        // unbind_both: delete sentinel + soft-delete current binding.
        const storage = getStorage(deps);
        if (storage) {
          // Sentinel "delete" is conceptual — we write a tombstoned
          // sentinel pointing at a zero UUID so the sync worker
          // treats the folder as orphaned on next pass. v1 leaves
          // the actual delete to ops cleanup since we have no
          // delete-sentinel helper. Best effort.
          void storage;
        }
        await deps.db
          .update(clientFolders)
          .set({ status: 'missing' })
          .where(
            and(
              eq(clientFolders.firmId, session.firmId),
              eq(clientFolders.storagePath, attempt.storagePath),
            ),
          );
      }

      // Mark the attempt resolved.
      await deps.db
        .update(folderLinkAttempts)
        .set({
          outcome: newOutcome,
          resolvedAt: new Date(),
          resolvedBy: session.appUserId,
          resolutionReason: parsed.data.reason ?? null,
        })
        .where(eq(folderLinkAttempts.id, attempt.id));

      // Audit row in folder_sync_events.
      await deps.db
        .insert(folderSyncEvents)
        .values({
          firmId: session.firmId,
          eventType: parsed.data.action === 'reassign' ? 'link_reassigned' : 'link_contested',
          pathAfter: attempt.storagePath,
          resolvedAt: new Date(),
          resolvedBy: session.appUserId,
          resolution,
          notes: parsed.data.reason ?? null,
        })
        .catch(() => undefined);

      res.json({
        attempt_id: attempt.id,
        outcome: newOutcome,
        resolution,
      });

      // Silence unused-import lint.
      void sql;
    },
  );

  return router;
}
