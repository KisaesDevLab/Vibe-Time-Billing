// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §5.2 — index progress publisher.
//
// Shared between apps/api (SSE consumer) and apps/worker (publisher).
// Lives in @vibe/core/storage so the worker doesn't import out of
// apps/api.
//
// Two Redis-shaped operations:
//   1. Update hash `storage:index:state:{client_folder_id}` (1h TTL)
//      so a page refresh during indexing shows a consistent
//      snapshot.
//   2. Publish a `progress` event to channel
//      `storage:index:{client_folder_id}` so live subscribers (the
//      IndexingProgressBar via SSE) get an immediate push.

// Structural subset of ioredis's Redis client — only the four
// methods we call. Avoids forcing @vibe/core to depend on ioredis;
// callers pass their own typed clients in.
export interface RedisLike {
  hset(key: string, fields: Record<string, string>): Promise<number | unknown>;
  expire(key: string, ttlSeconds: number): Promise<number | unknown>;
  publish(channel: string, message: string): Promise<number | unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

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
export const INDEX_STATE_TTL_SECONDS = 60 * 60;

export function indexChannel(clientFolderId: string): string {
  return `${INDEX_CHANNEL_PREFIX}${clientFolderId}`;
}

export function indexStateKey(clientFolderId: string): string {
  return `${INDEX_STATE_PREFIX}${clientFolderId}`;
}

export async function publishIndexProgress(
  redis: RedisLike,
  clientFolderId: string,
  snapshot: IndexProgressSnapshot,
): Promise<void> {
  const stateKey = indexStateKey(clientFolderId);
  const channel = indexChannel(clientFolderId);
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
  if (snapshot.status === 'completed' || snapshot.status === 'failed') {
    void redis.expire(stateKey, 60).catch(() => undefined);
  }
}

export async function readIndexState(
  redis: RedisLike,
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
