// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4a — Proposal create page. Pick a client, set a title, POST the
// header, redirect into the editor at /proposals/:id/edit.

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Combobox, Input, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface ClientRow {
  id: string;
  name: string;
}

export function ProposalCreatePage(): JSX.Element {
  const nav = useNavigate();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientId, setClientId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ClientRow[] }>('/api/staff/clients');
        setClients(r.items ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'load_failed');
      }
    })();
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!clientId || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string }>('/api/staff/proposals', {
        method: 'POST',
        body: JSON.stringify({ clientId, title: title.trim() }),
      });
      nav(`/proposals/${r.id}/edit`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 640 }}>
      <SectionHeading
        title="New proposal"
        description="Create a draft proposal. You can edit content and add tiers in the editor."
      />
      <Card>
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Client</span>
            <Combobox
              ariaLabel="Client"
              value={clientId}
              onChange={(v) => setClientId(v ?? '')}
              options={[
                { value: '', label: '— pick a client —' },
                ...clients.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Title</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Annual Tax + Bookkeeping 2026"
              required
            />
          </div>
          {err && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="submit" disabled={busy || !clientId || !title.trim()}>
              {busy ? 'Creating…' : 'Create + open editor'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
