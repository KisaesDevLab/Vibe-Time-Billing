// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Lazy client/engagement/work-code options for the timer popover's
// classify + save UI. Loads once, on first open (the chip itself must
// stay cheap — it renders in the header on every page). Same endpoints
// the Log time form uses; deliberately not extracted from TimeEntry.tsx,
// whose loader also carries pins/status/rounding concerns the timer
// doesn't need.

import { useEffect, useState } from 'react';

import type { ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';

interface EngagementOpt {
  id: string;
  name: string;
  clientId: string;
  status?: string;
  serviceLineId?: string | null;
}
interface ClientOpt {
  id: string;
  name: string;
}
interface WorkCodeOpt {
  id: string;
  name: string;
  serviceLineId?: string | null;
}

export interface EngagementOptions {
  loading: boolean;
  clients: ClientOpt[];
  engagements: EngagementOpt[];
  workCodes: WorkCodeOpt[];
  /** Combobox options for engagements, labeled "Client — Engagement";
   *  filtered to a client when a hint is present, active-only. */
  engagementOptions(clientId?: string | null): ComboboxOption[];
  workCodeOptions(engagementId?: string | null): ComboboxOption[];
}

export function useEngagementOptions(enabled: boolean): EngagementOptions {
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [engagements, setEngagements] = useState<EngagementOpt[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCodeOpt[]>([]);

  useEffect(() => {
    if (!enabled || loadedOnce) return;
    setLoadedOnce(true);
    setLoading(true);
    void (async () => {
      try {
        const [c, e, w] = await Promise.all([
          api<{ items: ClientOpt[] }>('/api/staff/clients/picker'),
          api<{ items: EngagementOpt[] }>('/api/staff/engagements/picker'),
          api<{ items: WorkCodeOpt[] }>('/api/staff/taxonomy/work-codes'),
        ]);
        setClients(c.items ?? []);
        setEngagements(e.items ?? []);
        setWorkCodes(w.items ?? []);
      } catch {
        // Popover shows an empty picker; user can finish on /time.
      } finally {
        setLoading(false);
      }
    })();
  }, [enabled, loadedOnce]);

  const clientName = (id: string): string => clients.find((c) => c.id === id)?.name ?? '';

  return {
    loading,
    clients,
    engagements,
    workCodes,
    engagementOptions(clientId) {
      return engagements
        .filter((e) => !e.status || e.status === 'ACTIVE')
        .filter((e) => !clientId || e.clientId === clientId)
        .map((e) => ({
          value: e.id,
          label: clientName(e.clientId) ? `${clientName(e.clientId)} — ${e.name}` : e.name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },
    workCodeOptions(engagementId) {
      const sl = engagements.find((e) => e.id === engagementId)?.serviceLineId ?? null;
      return workCodes
        .filter((w) => !w.serviceLineId || !sl || w.serviceLineId === sl)
        .map((w) => ({ value: w.id, label: w.name }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },
  };
}
