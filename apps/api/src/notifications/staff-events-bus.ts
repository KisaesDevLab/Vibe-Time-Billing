// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2 — the poke bus behind the staff event stream. Deliberately free of
// Express/RBAC imports so write paths anywhere (including modules the
// worker shares with the API) can nudge open streams without dragging the
// router's type surface along. See staff-events.ts for the stream itself.

import type { Redis } from 'ioredis';

import { logger } from '../logger';

export const CHANNEL_PREFIX = 'vibe:staff-events:';

// ---- in-process poke fan-out -------------------------------------------

type Poke = () => void;
const localListeners = new Map<string, Set<Poke>>();

export function addLocalListener(appUserId: string, fn: Poke): () => void {
  let set = localListeners.get(appUserId);
  if (!set) {
    set = new Set();
    localListeners.set(appUserId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) localListeners.delete(appUserId);
  };
}

function dispatchLocal(appUserId: string): void {
  const set = localListeners.get(appUserId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn();
    } catch (err) {
      logger.warn({ err }, 'staff-events: poke listener threw');
    }
  }
}

let subscriber: Redis | null = null;

/** Lazily open one pattern-subscribed Redis connection per process so pokes
 *  published by another replica reach connections held here. */
export function ensureSubscriber(redis: Redis): void {
  if (subscriber) return;
  subscriber = redis.duplicate();
  subscriber.on('error', (err) => logger.warn({ err }, 'staff-events: subscriber error'));
  void subscriber.psubscribe(`${CHANNEL_PREFIX}*`).catch((err) => {
    logger.warn({ err }, 'staff-events: psubscribe failed');
  });
  subscriber.on('pmessage', (_pattern, channel) => {
    dispatchLocal(channel.slice(CHANNEL_PREFIX.length));
  });
}

let publisher: Redis | null = null;

/** app.ts hands over the shared client once; write paths then poke
 *  without threading Redis through every router's deps. Tests never call
 *  this, so pokes stay in-process there. */
export function setStaffEventsPublisher(redis: Redis | null): void {
  publisher = redis;
}

/**
 * Nudge every open event stream for these users to tick now. Safe to call
 * from any write path; a missing Redis degrades to in-process only, and a
 * missing listener is a no-op. Never throws.
 */
export function pokeStaffEvents(appUserIds: Iterable<string>): void {
  for (const id of new Set(appUserIds)) {
    if (!id) continue;
    dispatchLocal(id);
    if (publisher) {
      void publisher.publish(`${CHANNEL_PREFIX}${id}`, '1').catch(() => undefined);
    }
  }
}

/** Poke everyone in a firm who could see a firm-wide counter move (intake
 *  submissions, client replies on requests). Cheap: one SMEMBERS-free scan
 *  of local listeners plus one firm-channel publish. */
export function pokeFirmStaffEvents(firmId: string): void {
  dispatchLocal(`firm:${firmId}`);
  if (publisher) {
    void publisher.publish(`${CHANNEL_PREFIX}firm:${firmId}`, '1').catch(() => undefined);
  }
}

/** Test/shutdown hook. */
export async function closeStaffEventsSubscriber(): Promise<void> {
  if (subscriber) {
    const s = subscriber;
    subscriber = null;
    await s.quit().catch(() => undefined);
  }
}
