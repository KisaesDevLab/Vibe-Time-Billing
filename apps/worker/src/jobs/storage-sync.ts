// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Storage sync worker (Phase 3 of FILE_MANAGER_ADDENDUM.md).
//
// Lists top-level prefixes under the firm's storage area, reads each
// sentinel, and reconciles against the `client_folders` table. Every
// state transition is appended to `folder_sync_events` so the admin
// "Storage Conflicts" panel (Phase 4/9) has a complete audit trail.
//
// The state machine is implemented as a pure function — `decideSyncPlan` —
// that takes the observed folders + the current DB snapshot + the set of
// open events, and returns a list of transitions. The orchestrator then
// applies those transitions in a single transaction. Splitting it this
// way means the decision logic is exhaustively testable without booting
// Postgres.
//
// Idempotency rules:
//   - No-state-change observations produce no events. Re-running the
//     tick with no underlying changes is a no-op.
//   - "Sticky warning" events (conflict, orphan, sentinel_lost,
//     sentinel_changed, missing, discovered-for-unbound) are emitted
//     only when there isn't already an OPEN (resolved_at IS NULL) event
//     of the same (event_type, path_after | client_folder_id) tuple.
//   - "Transition" events (renamed, discovered-for-new-row) always emit
//     because they correspond to a single moment of change.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { clientFolders, clients, firms, folderSyncEvents } from '@vibe/db/schema';
import {
  readSentinel,
  SENTINEL_FILE_DEFAULT,
  SENTINEL_FOLDER_DEFAULT,
  type ReadSentinelResult,
  type SentinelV1,
  type StorageClient,
} from '@vibe/storage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncEventType =
  | 'discovered'
  | 'renamed'
  | 'missing'
  | 'sentinel_changed'
  | 'sentinel_lost'
  | 'conflict'
  | 'orphan'
  | 'restored';

export type ClientFolderStatus = 'active' | 'renaming' | 'missing' | 'conflict' | 'orphan';

/** What the storage layer observed for one top-level folder. */
export interface ObservedFolder {
  path: string; // always ends with '/'
  sentinel: ReadSentinelResult;
}

/** Snapshot of a client_folders row at decision time. */
export interface ExistingFolderRow {
  id: string;
  clientId: string;
  storagePath: string;
  status: ClientFolderStatus;
  sentinelEtag: string | null;
}

/** Open (unresolved) folder_sync_events row used for dedupe. */
export interface OpenEventRow {
  eventType: SyncEventType;
  clientFolderId: string | null;
  pathAfter: string | null;
}

/** One row to upsert into client_folders. */
export interface FolderUpsert {
  /** Present when updating an existing row. */
  rowId: string | null;
  clientId: string;
  storagePath: string;
  sentinelEtag: string | null;
  status: ClientFolderStatus;
}

/** One row to write into folder_sync_events. */
export interface EventInsert {
  eventType: SyncEventType;
  clientFolderId: string | null;
  pathBefore: string | null;
  pathAfter: string | null;
  sentinelPayload: SentinelV1 | { reason: string; raw_error?: string } | null;
}

/** Plan returned by decideSyncPlan + applied by the orchestrator. */
export interface SyncPlan {
  upserts: FolderUpsert[];
  markStatus: { rowId: string; status: ClientFolderStatus }[];
  events: EventInsert[];
}

export interface DecideSyncPlanInput {
  observed: ObservedFolder[];
  existing: ExistingFolderRow[];
  /** Set of client.id values for the operating firm. */
  knownClientIds: Set<string>;
  openEvents: OpenEventRow[];
}

// ---------------------------------------------------------------------------
// Pure state-machine planner
// ---------------------------------------------------------------------------

/**
 * Computes the set of mutations + events needed to reconcile what the
 * sync worker saw against the current DB snapshot. Pure: zero IO.
 */
export function decideSyncPlan(input: DecideSyncPlanInput): SyncPlan {
  const plan: SyncPlan = { upserts: [], markStatus: [], events: [] };

  const byClientId = new Map<string, ExistingFolderRow>();
  for (const row of input.existing) byClientId.set(row.clientId, row);
  const byPath = new Map<string, ExistingFolderRow>();
  for (const row of input.existing) byPath.set(row.storagePath, row);

  const observedPaths = new Set<string>();
  // Multiple sentinels with the same client_id signal a duplicate folder.
  const claimsByClient = new Map<string, ObservedFolder[]>();
  for (const obs of input.observed) {
    observedPaths.add(obs.path);
    if (obs.sentinel.ok) {
      const list = claimsByClient.get(obs.sentinel.payload.client_id) ?? [];
      list.push(obs);
      claimsByClient.set(obs.sentinel.payload.client_id, list);
    }
  }

  // Pre-compute conflict set: any client_id with >1 observed claim.
  const conflictClientIds = new Set<string>();
  for (const [cid, list] of claimsByClient) {
    if (list.length > 1) conflictClientIds.add(cid);
  }

  // Dedupe helpers.
  const hasOpenEvent = (
    eventType: SyncEventType,
    opts: { clientFolderId?: string | null; pathAfter?: string | null },
  ): boolean =>
    input.openEvents.some(
      (e) =>
        e.eventType === eventType &&
        (opts.clientFolderId === undefined || e.clientFolderId === (opts.clientFolderId ?? null)) &&
        (opts.pathAfter === undefined || e.pathAfter === (opts.pathAfter ?? null)),
    );

  // ----- Pass 1: per-folder classification -----------------------------
  for (const obs of input.observed) {
    const s = obs.sentinel;

    if (!s.ok) {
      // Folder lacks a usable sentinel. Map by reason.
      const rowAtPath = byPath.get(obs.path) ?? null;

      if (s.reason === 'missing') {
        if (rowAtPath) {
          // Existing row, sentinel disappeared.
          if (!hasOpenEvent('sentinel_lost', { clientFolderId: rowAtPath.id })) {
            plan.events.push({
              eventType: 'sentinel_lost',
              clientFolderId: rowAtPath.id,
              pathBefore: obs.path,
              pathAfter: obs.path,
              sentinelPayload: null,
            });
          }
          // Per spec: status stays active but flagged via event.
        } else {
          // Unbound folder, no sentinel. Surface for onboarding.
          if (!hasOpenEvent('discovered', { clientFolderId: null, pathAfter: obs.path })) {
            plan.events.push({
              eventType: 'discovered',
              clientFolderId: null,
              pathBefore: null,
              pathAfter: obs.path,
              sentinelPayload: null,
            });
          }
        }
        continue;
      }

      if (s.reason === 'wrong_firm') {
        // Sentinel valid but firm_id mismatches → orphan.
        if (rowAtPath) {
          if (rowAtPath.status !== 'orphan') {
            plan.markStatus.push({ rowId: rowAtPath.id, status: 'orphan' });
          }
          if (!hasOpenEvent('orphan', { clientFolderId: rowAtPath.id })) {
            plan.events.push({
              eventType: 'orphan',
              clientFolderId: rowAtPath.id,
              pathBefore: obs.path,
              pathAfter: obs.path,
              sentinelPayload: s.payload,
            });
          }
        } else if (!hasOpenEvent('orphan', { clientFolderId: null, pathAfter: obs.path })) {
          plan.events.push({
            eventType: 'orphan',
            clientFolderId: null,
            pathBefore: null,
            pathAfter: obs.path,
            sentinelPayload: s.payload,
          });
        }
        continue;
      }

      // unparseable | schema_invalid → sentinel_changed.
      const errorPayload = {
        reason: s.reason,
        raw_error: 'error' in s ? s.error : undefined,
      };
      if (rowAtPath) {
        if (!hasOpenEvent('sentinel_changed', { clientFolderId: rowAtPath.id })) {
          plan.events.push({
            eventType: 'sentinel_changed',
            clientFolderId: rowAtPath.id,
            pathBefore: obs.path,
            pathAfter: obs.path,
            sentinelPayload: errorPayload,
          });
        }
      } else if (!hasOpenEvent('sentinel_changed', { clientFolderId: null, pathAfter: obs.path })) {
        plan.events.push({
          eventType: 'sentinel_changed',
          clientFolderId: null,
          pathBefore: null,
          pathAfter: obs.path,
          sentinelPayload: errorPayload,
        });
      }
      continue;
    }

    // ----- Valid sentinel ---------------------------------------------
    const sentinel = s.payload;
    const etag = s.etag;

    // Conflict trumps everything else: two observed folders for the same client_id.
    if (conflictClientIds.has(sentinel.client_id)) {
      const rowAtPath = byPath.get(obs.path) ?? null;
      if (rowAtPath) {
        if (rowAtPath.status !== 'conflict') {
          plan.markStatus.push({ rowId: rowAtPath.id, status: 'conflict' });
        }
        if (!hasOpenEvent('conflict', { clientFolderId: rowAtPath.id })) {
          plan.events.push({
            eventType: 'conflict',
            clientFolderId: rowAtPath.id,
            pathBefore: obs.path,
            pathAfter: obs.path,
            sentinelPayload: sentinel,
          });
        }
      } else if (!hasOpenEvent('conflict', { clientFolderId: null, pathAfter: obs.path })) {
        plan.events.push({
          eventType: 'conflict',
          clientFolderId: null,
          pathBefore: null,
          pathAfter: obs.path,
          sentinelPayload: sentinel,
        });
      }
      continue;
    }

    // Client doesn't exist in our `clients` table → log as discovered/orphan
    // so admin resolves in onboarding. We don't auto-bind.
    if (!input.knownClientIds.has(sentinel.client_id)) {
      if (!hasOpenEvent('discovered', { clientFolderId: null, pathAfter: obs.path })) {
        plan.events.push({
          eventType: 'discovered',
          clientFolderId: null,
          pathBefore: null,
          pathAfter: obs.path,
          sentinelPayload: sentinel,
        });
      }
      continue;
    }

    const existingForClient = byClientId.get(sentinel.client_id) ?? null;
    if (existingForClient && existingForClient.storagePath === obs.path) {
      const wasInactive = existingForClient.status !== 'active';
      const etagChanged = existingForClient.sentinelEtag !== etag;
      if (etagChanged) {
        plan.upserts.push({
          rowId: existingForClient.id,
          clientId: sentinel.client_id,
          storagePath: obs.path,
          sentinelEtag: etag,
          status: 'active',
        });
      } else if (wasInactive) {
        plan.markStatus.push({ rowId: existingForClient.id, status: 'active' });
      }
      if (wasInactive) {
        plan.events.push({
          eventType: 'restored',
          clientFolderId: existingForClient.id,
          pathBefore: existingForClient.storagePath,
          pathAfter: obs.path,
          sentinelPayload: sentinel,
        });
      }
      continue;
    }

    if (existingForClient && existingForClient.storagePath !== obs.path) {
      // Path changed — File Explorer rename. Update storage_path + log renamed.
      plan.upserts.push({
        rowId: existingForClient.id,
        clientId: sentinel.client_id,
        storagePath: obs.path,
        sentinelEtag: etag,
        status: 'active',
      });
      plan.events.push({
        eventType: 'renamed',
        clientFolderId: existingForClient.id,
        pathBefore: existingForClient.storagePath,
        pathAfter: obs.path,
        sentinelPayload: sentinel,
      });
      continue;
    }

    // No existing row for this client_id → create one + log discovered.
    plan.upserts.push({
      rowId: null,
      clientId: sentinel.client_id,
      storagePath: obs.path,
      sentinelEtag: etag,
      status: 'active',
    });
    plan.events.push({
      eventType: 'discovered',
      clientFolderId: null, // resolved by orchestrator post-INSERT
      pathBefore: null,
      pathAfter: obs.path,
      sentinelPayload: sentinel,
    });
  }

  // ----- Pass 2: rows the scan didn't see -----------------------------
  const observedClientIds = new Set<string>();
  for (const obs of input.observed) {
    if (obs.sentinel.ok) observedClientIds.add(obs.sentinel.payload.client_id);
  }
  for (const row of input.existing) {
    if (observedPaths.has(row.storagePath)) continue;
    // Row exists in DB but its path wasn't observed. If a renamed event
    // already covered this in pass 1 (sentinel found at a NEW path for
    // this client), the upsert above changed storagePath — that's handled.
    if (observedClientIds.has(row.clientId)) continue;
    if (row.status === 'missing') continue; // already flagged
    plan.markStatus.push({ rowId: row.id, status: 'missing' });
    plan.events.push({
      eventType: 'missing',
      clientFolderId: row.id,
      pathBefore: row.storagePath,
      pathAfter: null,
      sentinelPayload: null,
    });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RunStorageSyncTickOpts {
  /** Override the firm to scope to. Default: single firm row. */
  firmId?: string;
  topPrefix?: string;
  systemPrefix?: string;
  sentinelFolder?: string;
  sentinelFile?: string;
}

export interface StorageSyncResult {
  firmId: string | null;
  scannedFolders: number;
  upserts: number;
  markMissing: number;
  markStatus: number;
  events: number;
  skipped: boolean;
  skipReason?: string;
}

const SYSTEM_PREFIX_DEFAULT = '_system/';

/**
 * Single sync tick. Designed to be called from a BullMQ cron handler.
 * Idempotent: re-running with no underlying changes produces no events.
 */
export async function runStorageSyncTick(
  db: Database,
  storage: StorageClient,
  log: Logger,
  opts: RunStorageSyncTickOpts = {},
): Promise<StorageSyncResult> {
  const topPrefix = opts.topPrefix ?? process.env['STORAGE_TOP_PREFIX'] ?? '';
  const systemPrefix =
    opts.systemPrefix ?? process.env['STORAGE_SYSTEM_PREFIX'] ?? SYSTEM_PREFIX_DEFAULT;
  const sentinelFolder =
    opts.sentinelFolder ?? process.env['STORAGE_SENTINEL_FOLDER'] ?? SENTINEL_FOLDER_DEFAULT;
  const sentinelFile =
    opts.sentinelFile ?? process.env['STORAGE_SENTINEL_FILE'] ?? SENTINEL_FILE_DEFAULT;

  let firmId = opts.firmId ?? null;
  if (!firmId) {
    const [firmRow] = await db.select({ id: firms.id }).from(firms).limit(1);
    firmId = firmRow?.id ?? null;
  }
  if (!firmId) {
    log.warn('storage-sync: no firm configured, skipping');
    return {
      firmId: null,
      scannedFolders: 0,
      upserts: 0,
      markMissing: 0,
      markStatus: 0,
      events: 0,
      skipped: true,
      skipReason: 'no_firm',
    };
  }

  // ----- List top-level folders ----------------------------------------
  const observed: ObservedFolder[] = [];
  for await (const entry of storage.list(topPrefix, { delimiter: '/' })) {
    if (entry.kind !== 'prefix') continue;
    if (systemPrefix && entry.key === systemPrefix) continue;
    if (systemPrefix && entry.key.startsWith(systemPrefix)) continue;
    const sentinel = await readSentinel(storage, entry.key, {
      folder: sentinelFolder,
      file: sentinelFile,
      expectedFirmId: firmId,
    });
    observed.push({ path: entry.key, sentinel });
  }

  // ----- Snapshot DB state for this firm -------------------------------
  const existingRows = await db
    .select({
      id: clientFolders.id,
      clientId: clientFolders.clientId,
      storagePath: clientFolders.storagePath,
      status: clientFolders.status,
      sentinelEtag: clientFolders.sentinelEtag,
    })
    .from(clientFolders)
    .where(eq(clientFolders.firmId, firmId));
  const existing: ExistingFolderRow[] = existingRows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    storagePath: r.storagePath,
    status: r.status as ClientFolderStatus,
    sentinelEtag: r.sentinelEtag,
  }));

  const clientRows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.firmId, firmId));
  const knownClientIds = new Set(clientRows.map((r) => r.id));

  const openEventRows = await db
    .select({
      eventType: folderSyncEvents.eventType,
      clientFolderId: folderSyncEvents.clientFolderId,
      pathAfter: folderSyncEvents.pathAfter,
    })
    .from(folderSyncEvents)
    .where(and(eq(folderSyncEvents.firmId, firmId), isNull(folderSyncEvents.resolvedAt)));
  const openEvents: OpenEventRow[] = openEventRows.map((r) => ({
    eventType: r.eventType as SyncEventType,
    clientFolderId: r.clientFolderId,
    pathAfter: r.pathAfter,
  }));

  const plan = decideSyncPlan({ observed, existing, knownClientIds, openEvents });

  let upsertCount = 0;
  let markMissingCount = 0;
  let markStatusCount = 0;
  let eventCount = 0;

  await db.transaction(async (tx) => {
    // 1) Apply upserts and capture newly created row ids so we can
    //    backfill clientFolderId on discovered events.
    const newRowIdByPath = new Map<string, string>();
    for (const u of plan.upserts) {
      if (u.rowId) {
        await tx
          .update(clientFolders)
          .set({
            storagePath: u.storagePath,
            sentinelEtag: u.sentinelEtag,
            status: u.status,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(clientFolders.id, u.rowId));
      } else {
        const [inserted] = await tx
          .insert(clientFolders)
          .values({
            firmId: firmId!,
            clientId: u.clientId,
            storagePath: u.storagePath,
            sentinelEtag: u.sentinelEtag,
            status: u.status,
            lastSyncedAt: new Date(),
          })
          .returning({ id: clientFolders.id });
        if (inserted) newRowIdByPath.set(u.storagePath, inserted.id);
      }
      upsertCount += 1;
    }

    // 2) Apply status flips that didn't come with a path/etag change.
    for (const m of plan.markStatus) {
      await tx
        .update(clientFolders)
        .set({ status: m.status, updatedAt: new Date() })
        .where(eq(clientFolders.id, m.rowId));
      if (m.status === 'missing') markMissingCount += 1;
      else markStatusCount += 1;
    }

    // 3) Insert events; backfill clientFolderId for freshly inserted rows.
    for (const ev of plan.events) {
      let clientFolderId = ev.clientFolderId;
      if (!clientFolderId && ev.pathAfter) {
        clientFolderId = newRowIdByPath.get(ev.pathAfter) ?? null;
      }
      await tx.insert(folderSyncEvents).values({
        firmId: firmId!,
        clientFolderId,
        eventType: ev.eventType,
        pathBefore: ev.pathBefore,
        pathAfter: ev.pathAfter,
        sentinelPayload: ev.sentinelPayload as unknown,
      });
      eventCount += 1;
    }

    // 4) Touch last_synced_at on every existing row that was observed but
    //    didn't otherwise mutate, so the admin UI shows a fresh timestamp.
    const touched = plan.upserts.filter((u) => u.rowId).map((u) => u.rowId!) as string[];
    const observedRowIds = existing
      .filter((r) => observed.some((o) => o.path === r.storagePath))
      .map((r) => r.id)
      .filter((id) => !touched.includes(id));
    if (observedRowIds.length > 0) {
      await tx
        .update(clientFolders)
        .set({ lastSyncedAt: new Date() })
        .where(inArray(clientFolders.id, observedRowIds));
    }
  });

  log.info(
    {
      firmId,
      scannedFolders: observed.length,
      upserts: upsertCount,
      markMissing: markMissingCount,
      markStatus: markStatusCount,
      events: eventCount,
    },
    'storage-sync tick complete',
  );

  return {
    firmId,
    scannedFolders: observed.length,
    upserts: upsertCount,
    markMissing: markMissingCount,
    markStatus: markStatusCount,
    events: eventCount,
    skipped: false,
  };
}
