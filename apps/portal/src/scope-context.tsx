// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP7 — Portal-wide scope toggle. Persists the choice in localStorage
// so navigating between pages keeps the consolidated view sticky.
//
// Scope values:
//   active          — only the session.activeClientId
//   all_accessible  — every client the identity can switch to

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { api } from './api-client';

export type Scope = 'active' | 'all_accessible';

const STORAGE_KEY = 'vibe-portal-scope';

interface ClientRow {
  id: string;
  name: string;
}

interface ScopeContextValue {
  scope: Scope;
  setScope: (s: Scope) => void;
  /** Convenience: append "?scope=all_accessible" to API urls when consolidated. */
  scopeQuery: string;
  /** id → human display name lookup, populated lazily. Empty until first hit. */
  clientNames: Record<string, string>;
  /** True iff the identity has access to >1 client (toggle worth showing). */
  hasMultiple: boolean;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

function readStored(): Scope {
  if (typeof window === 'undefined') return 'active';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'all_accessible' ? 'all_accessible' : 'active';
}

export function ScopeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [scope, setScopeState] = useState<Scope>(readStored);
  const [clientNames, setClientNames] = useState<Record<string, string>>({});
  const [count, setCount] = useState(0);

  // Load accessible-clients list once so the consolidated-view toggle
  // and per-row name tags can resolve client IDs.
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ClientRow[] }>('/api/portal/profile/clients');
        const map: Record<string, string> = {};
        for (const c of r.items ?? []) map[c.id] = c.name;
        setClientNames(map);
        setCount(r.items?.length ?? 0);
      } catch {
        // best-effort — toggle simply won't appear if list fetch failed
      }
    })();
  }, []);

  const setScope = useCallback((s: Scope) => {
    setScopeState(s);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, s);
  }, []);

  const value = useMemo<ScopeContextValue>(
    () => ({
      scope,
      setScope,
      scopeQuery: scope === 'all_accessible' ? '?scope=all_accessible' : '',
      clientNames,
      hasMultiple: count > 1,
    }),
    [scope, setScope, clientNames, count],
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext);
  if (!ctx) {
    // Returning a safe default rather than throwing means pages that
    // forget to wrap with the provider still render in single-client
    // mode rather than crashing.
    return {
      scope: 'active',
      setScope: () => undefined,
      scopeQuery: '',
      clientNames: {},
      hasMultiple: false,
    };
  }
  return ctx;
}
