// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Hand-rolled undo/redo stack keyed off a deep-equality serializer.
// The editor pushes every distinct tree state onto past; setting via
// undo pops one and re-pushes to future. The bounded stack keeps the
// last 200 snapshots so a long editing session can't OOM the tab.

import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_HISTORY = 200;

export interface UndoHistory<T> {
  state: T;
  setState: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  // Push current state onto the past stack without changing state.
  // Useful when an external load supplies a new baseline.
  reset: (next: T) => void;
}

export function useUndoHistory<T>(initial: T, serialize: (v: T) => string): UndoHistory<T> {
  const [state, set] = useState<T>(initial);
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const lastSerializedRef = useRef<string>(serialize(initial));

  const setState = useCallback(
    (next: T) => {
      const nextSerialized = serialize(next);
      if (nextSerialized === lastSerializedRef.current) {
        // No-op change — don't pollute history.
        return;
      }
      pastRef.current.push(state);
      if (pastRef.current.length > MAX_HISTORY) {
        pastRef.current.shift();
      }
      futureRef.current = [];
      lastSerializedRef.current = nextSerialized;
      set(next);
    },
    [state, serialize],
  );

  const undo = useCallback(() => {
    const prior = pastRef.current.pop();
    if (prior === undefined) return;
    futureRef.current.push(state);
    lastSerializedRef.current = serialize(prior);
    set(prior);
  }, [state, serialize]);

  const redo = useCallback(() => {
    const future = futureRef.current.pop();
    if (future === undefined) return;
    pastRef.current.push(state);
    lastSerializedRef.current = serialize(future);
    set(future);
  }, [state, serialize]);

  const reset = useCallback(
    (next: T) => {
      pastRef.current = [];
      futureRef.current = [];
      lastSerializedRef.current = serialize(next);
      set(next);
    },
    [serialize],
  );

  return {
    state,
    setState,
    undo,
    redo,
    reset,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}

// =====================================================================
// Keyboard wiring: Ctrl/Cmd-Z = undo, Ctrl/Cmd-Shift-Z = redo. Bound
// to the document so the user can undo from anywhere inside the editor
// even when focus is in a textarea.
// =====================================================================

export function useUndoKeyboard(handlers: { undo: () => void; redo: () => void }): void {
  const { undo, redo } = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);
}
