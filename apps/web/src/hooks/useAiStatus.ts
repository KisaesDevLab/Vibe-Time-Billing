// SPDX-License-Identifier: Elastic-2.0
//
// useAiStatus — single-fetch hook that gates every embedded AI panel.
// Returns null while loading; an AiStatus object after.

import { useEffect, useState } from 'react';

import { api } from '../api-client';

export interface AiStatus {
  enabled: boolean;
  optedIn: boolean;
  providerWired: boolean;
  providerId: string | null;
}

// Cache across the React tree so we hit /ai/status once per session.
let cached: AiStatus | null = null;
const subscribers = new Set<(s: AiStatus | null) => void>();
let inFlight: Promise<AiStatus> | null = null;

function loadOnce(): Promise<AiStatus> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const r = await api<AiStatus>('/api/staff/ai/status');
      cached = r;
      return r;
    } catch {
      cached = {
        enabled: false,
        optedIn: false,
        providerWired: false,
        providerId: null,
      };
      return cached;
    } finally {
      inFlight = null;
      for (const fn of subscribers) fn(cached);
    }
  })();
  return inFlight;
}

export function useAiStatus(): AiStatus | null {
  const [s, setS] = useState<AiStatus | null>(cached);
  useEffect(() => {
    let mounted = true;
    void loadOnce().then((r) => {
      if (mounted) setS(r);
    });
    function update(next: AiStatus | null): void {
      if (mounted) setS(next);
    }
    subscribers.add(update);
    return () => {
      mounted = false;
      subscribers.delete(update);
    };
  }, []);
  return s;
}

export function aiUsable(status: AiStatus | null): boolean {
  if (!status) return false;
  return status.enabled && status.optedIn && status.providerWired;
}
