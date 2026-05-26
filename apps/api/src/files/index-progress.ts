// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §5.2 — index progress publisher.
//
// The sync worker calls these helpers after each batch of files
// indexed to:
//   1. Update the Redis hash `storage:index:state:{client_folder_id}`
//      (1h TTL) so a page refresh during indexing still shows a
//      consistent snapshot.
//   2. Publish a `progress` event to `storage:index:{client_folder_id}`
//      so live subscribers (the IndexingProgressBar via SSE) get an
//      immediate push.
//
// Helper is pure aside from the Redis client. Tests inject a fake
// Redis. Production wires through the existing apps/worker Redis
// pool.

import type { Redis } from 'ioredis';

export type IndexStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface IndexProgressSnapshot {
  status: IndexStatus;
  files_total: number;
  files_indexed: number;
  bytes_indexed: number;
  visible_count: number;
  private_count: number;
  started_at: string;
  estimated_completion?: string | null;
  last_file_name?: string | null;
}

export const INDEX_CHANNEL_PREFIX = 'storage:index:';
export const INDEX_STATE_PREFIX = 'storage:index:state:';
export const INDEX_STATE_TTL_SECONDS = 60 * 60; // 1h per spec.

export function indexChannel(clientFolderId: string): string {
  return `${INDEX_CHANNEL_PREFIX}${clientFolderId}`;
}

export function indexStateKey(clientFolderId: string): string {
  return `${INDEX_STATE_PREFIX}${clientFolderId}`;
}

// Write the current snapshot to the Redis hash + publish a
// progress event. The two writes are best-effort independent — a
// hash-update failure still publishes (subscribers see the update);
// a publish failure still updates state (next reconnect reads the
// snapshot).
export async function publishIndexProgress(
  redis: Redis,
  clientFolderId: string,
  snapshot: IndexProgressSnapshot,
): Promise<void> {
  const stateKey = indexStateKey(clientFolderId);
  const channel = indexChannel(clientFolderId);
  // Convert all values to strings for HSET (ioredis is permissive
  // but we want to be explicit).
  const flat: Record<string, string> = {
    status: snapshot.status,
    files_total: String(snapshot.files_total),
    files_indexed: String(snapshot.files_indexed),
    bytes_indexed: String(snapshot.bytes_indexed),
    visible_count: String(snapshot.visible_count),
    private_count: String(snapshot.private_count),
    started_at: snapshot.started_at,
  };
  if (snapshot.estimated_completion) {
    flat['estimated_completion'] = snapshot.estimated_completion;
  }
  if (snapshot.last_file_name) {
    flat['last_file_name'] = snapshot.last_file_name;
  }
  await redis.hset(stateKey, flat).catch(() => undefined);
  await redis.expire(stateKey, INDEX_STATE_TTL_SECONDS).catch(() => undefined);
  await redis.publish(channel, JSON.stringify(snapshot)).catch(() => undefined);
  // Clear state after completed/failed terminal events on a delay
  // so reconnecting clients see the final value briefly.
  if (snapshot.status === 'completed' || snapshot.status === 'failed') {
    // Don't await — the TTL takes care of it eventually, but we
    // surface 'completed' to anyone polling for the next minute.
    void redis.expire(stateKey, 60).catch(() => undefined);
  }
}

// Read the current snapshot (or null when the hash is unset / TTL
// expired). Used by the SSE route to send an immediate initial
// event when a client reconnects mid-indexing.
export async function readIndexState(
  redis: Redis,
  clientFolderId: string,
): Promise<IndexProgressSnapshot | null> {
  const key = indexStateKey(clientFolderId);
  const flat = await redis.hgetall(key).catch(() => ({}) as Record<string, string>);
  if (!flat || Object.keys(flat).length === 0) return null;
  const status = (flat['status'] ?? 'queued') as IndexStatus;
  return {
    status,
    files_total: Number(flat['files_total'] ?? 0),
    files_indexed: Number(flat['files_indexed'] ?? 0),
    bytes_indexed: Number(flat['bytes_indexed'] ?? 0),
    visible_count: Number(flat['visible_count'] ?? 0),
    private_count: Number(flat['private_count'] ?? 0),
    started_at: flat['started_at'] ?? new Date().toISOString(),
    estimated_completion: flat['estimated_completion'] ?? null,
    last_file_name: flat['last_file_name'] ?? null,
  };
}
