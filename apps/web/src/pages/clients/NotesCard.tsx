// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client notes tab (v2 followup). Uses the existing /clients/:id/notes
// endpoint family (list / POST / DELETE / PATCH /:noteId/pin).

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Note {
  id: string;
  authorId: string;
  body: string;
  pinned: boolean;
  createdAt: string;
}

interface Props {
  clientId: string;
}

const fieldStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
  width: '100%',
  resize: 'vertical' as const,
};

export function NotesCard({ clientId }: Props): JSX.Element {
  const [items, setItems] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Note[] }>(`/api/staff/clients/${clientId}/notes`);
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function add(): Promise<void> {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/clients/${clientId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  async function togglePin(n: Note): Promise<void> {
    try {
      await api(`/api/staff/clients/${clientId}/notes/${n.id}/pin`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned: !n.pinned }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'pin_failed');
    }
  }

  async function remove(n: Note): Promise<void> {
    if (!confirm('Delete this note?')) return;
    try {
      await api(`/api/staff/clients/${clientId}/notes/${n.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete_failed');
    }
  }

  return (
    <Card title={`Notes (${items.length})`}>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Add a note…"
          style={fieldStyle}
          aria-label="New note"
        />
        <div>
          <Button size="sm" onClick={() => void add()} disabled={busy || !draft.trim()}>
            Add note
          </Button>
        </div>
      </div>
      {items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No notes yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map((n) => (
            <div
              key={n.id}
              style={{
                padding: 10,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                display: 'grid',
                gap: 4,
                background: n.pinned ? tokens.color.surface : 'transparent',
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: tokens.color.textMuted, flex: 1 }}>
                  {new Date(n.createdAt).toLocaleString()}
                </span>
                {n.pinned && <Pill tone="accent">pinned</Pill>}
                <Button size="sm" variant="ghost" onClick={() => void togglePin(n)}>
                  {n.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(n)}>
                  Delete
                </Button>
              </div>
              <pre
                style={{
                  margin: 0,
                  fontSize: 13,
                  whiteSpace: 'pre-wrap',
                  fontFamily: tokens.font.body,
                  color: tokens.color.text,
                }}
              >
                {n.body}
              </pre>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
