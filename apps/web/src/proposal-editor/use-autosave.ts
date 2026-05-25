// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4b — Debounced autosave hook. Watches a "dirty value," waits for
// `delayMs` of quiet, then fires `save(value)`. Concurrent saves are
// serialized: if a new dirty value lands while a save is in flight,
// the next save kicks off only after the current one settles.

import { useEffect, useRef, useState } from 'react';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface AutosaveResult {
  status: SaveStatus;
  lastSavedAt: Date | null;
  lastError: Error | null;
  // Force-flush any pending debounce immediately (e.g. on close).
  flush: () => Promise<void>;
}

export function useAutosave<T>(
  value: T,
  baseline: T,
  save: (next: T) => Promise<void>,
  delayMs = 2000,
  equal: (a: T, b: T) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b),
): AutosaveResult {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [lastError, setLastError] = useState<Error | null>(null);
  const pendingRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightRef = useRef(false);
  const queuedValueRef = useRef<T | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  async function doSave(next: T): Promise<void> {
    inFlightRef.current = true;
    setStatus('saving');
    try {
      await save(next);
      setStatus('saved');
      setLastSavedAt(new Date());
      setLastError(null);
    } catch (e) {
      setStatus('error');
      setLastError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      inFlightRef.current = false;
      const queued = queuedValueRef.current;
      queuedValueRef.current = null;
      if (queued !== null) {
        void doSave(queued);
      }
    }
  }

  useEffect(() => {
    if (equal(value, baseline)) {
      setStatus(lastSavedAt ? 'saved' : 'idle');
      return;
    }
    setStatus('pending');
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      if (inFlightRef.current) {
        queuedValueRef.current = valueRef.current;
      } else {
        void doSave(valueRef.current);
      }
    }, delayMs);
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, baseline]);

  async function flush(): Promise<void> {
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    if (equal(valueRef.current, baseline)) return;
    await doSave(valueRef.current);
  }

  return { status, lastSavedAt, lastError, flush };
}
