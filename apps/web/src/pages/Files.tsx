// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Top-level Files page (v2 Part 1) — four sub-tabs:
//   Client files · Internal files · My files · Recently viewed
//
// Client files = browser over a chosen client.
// Internal files = firm-scoped (no client gate) browser.
// My files = the same browser scoped to files I uploaded.
// Recently viewed = localStorage-backed; no backend.

import { useEffect, useMemo, useState } from 'react';

import { Card, Combobox, Pill, Tabs, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';

import { FileBrowser } from './clients/FileBrowser';

interface ClientRow {
  id: string;
  name: string;
}

interface RecentlyViewed {
  id: string;
  fileName: string;
  viewedAt: string;
  scope: string;
  clientId?: string;
}

type TabKey = 'client' | 'internal' | 'mine' | 'recent';

export function FilesPage(): JSX.Element {
  const { me } = useAuth();
  const [tab, setTab] = useState<TabKey>('client');
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [chosenClientId, setChosenClientId] = useState<string>('');
  const [myClientId, setMyClientId] = useState<string>('');
  const [recent, setRecent] = useState<RecentlyViewed[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ClientRow[] }>('/api/staff/clients?status=ACTIVE');
        const items = r.items ?? [];
        setClients(items);
        if (items.length > 0 && !chosenClientId) setChosenClientId(items[0]!.id);
        if (items.length > 0 && !myClientId) setMyClientId(items[0]!.id);
      } catch {
        setClients([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab !== 'recent') return;
    try {
      const raw = localStorage.getItem('__vibe_recently_viewed_files');
      setRecent(raw ? (JSON.parse(raw) as RecentlyViewed[]) : []);
    } catch {
      setRecent([]);
    }
  }, [tab]);

  const clientOptions = useMemo<ComboboxOption[]>(
    () => clients.map((c) => ({ value: c.id, label: c.name })),
    [clients],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Files</h1>
        <Pill tone="accent">v2</Pill>
      </div>

      <Tabs
        active={tab}
        onChange={(v) => setTab(v as TabKey)}
        tabs={[
          { key: 'client', label: 'Client files' },
          { key: 'internal', label: 'Internal files' },
          { key: 'mine', label: 'My files' },
          { key: 'recent', label: 'Recently viewed' },
        ]}
      />

      {tab === 'client' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Client</span>
            <div style={{ minWidth: 280 }}>
              <Combobox
                options={clientOptions}
                value={chosenClientId}
                onChange={setChosenClientId}
                placeholder="Pick a client"
                ariaLabel="Client picker"
              />
            </div>
          </div>
          {chosenClientId && <FileBrowser scope="client" clientId={chosenClientId} />}
        </div>
      )}

      {tab === 'internal' && <FileBrowser scope="internal" />}

      {tab === 'mine' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              Showing files uploaded by you across clients.
            </span>
            <div style={{ minWidth: 280, marginLeft: 'auto' }}>
              <Combobox
                options={clientOptions}
                value={myClientId}
                onChange={setMyClientId}
                placeholder="Scope to client"
                ariaLabel="Client picker for My files"
              />
            </div>
          </div>
          {myClientId && me?.appUserId && (
            <FileBrowser scope="client" clientId={myClientId} uploadedById={me.appUserId} />
          )}
        </div>
      )}

      {tab === 'recent' && (
        <Card title="Recently viewed">
          {recent.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              No recently viewed files yet. Open a file from any view to see it here.
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th
                    style={{
                      padding: '6px',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: tokens.color.textMuted,
                    }}
                  >
                    File
                  </th>
                  <th
                    style={{
                      padding: '6px',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: tokens.color.textMuted,
                    }}
                  >
                    Scope
                  </th>
                  <th
                    style={{
                      padding: '6px',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: tokens.color.textMuted,
                    }}
                  >
                    Viewed
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr
                    key={`${r.id}-${r.viewedAt}`}
                    style={{ borderTop: `1px solid ${tokens.color.border}` }}
                  >
                    <td style={{ padding: '6px' }}>📄 {r.fileName}</td>
                    <td style={{ padding: '6px' }}>
                      {r.scope === 'internal' ? 'Internal' : 'Client'}
                    </td>
                    <td style={{ padding: '6px', color: tokens.color.textMuted }}>
                      {new Date(r.viewedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
