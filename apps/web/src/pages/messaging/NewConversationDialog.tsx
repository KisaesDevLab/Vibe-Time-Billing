// SPDX-License-Identifier: Elastic-2.0
//
// Start a staff conversation: pick one teammate (direct) or several (group,
// with an optional name), and optionally send a first message.

import { useEffect, useMemo, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

interface StaffOpt {
  id: string;
  name: string;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 8,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 14,
};

export function NewConversationDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (threadId: string) => void;
}): JSX.Element {
  const [staff, setStaff] = useState<StaffOpt[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ staff: StaffOpt[] }>('/api/staff/internal-messaging/directory')
      .then((r) => setStaff(r.staff))
      .catch((err: ApiError) => setError(err.message));
  }, []);

  const filtered = useMemo(
    () => staff.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase())),
    [staff, query],
  );
  const isGroup = selected.size > 1;

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create(): Promise<void> {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ threadId: string }>('/api/staff/internal-messaging/threads', {
        method: 'POST',
        body: JSON.stringify({
          memberIds: Array.from(selected),
          title: isGroup && title.trim() ? title.trim() : undefined,
          body: body.trim() || undefined,
        }),
      });
      onCreated(r.threadId);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New conversation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          padding: 20,
          width: 'min(460px, 92vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          display: 'grid',
          gap: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>New conversation</h3>
        <input
          style={inputStyle}
          placeholder="Search teammates…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 2 }}>
          {filtered.map((s) => (
            <label
              key={s.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                fontSize: 14,
                padding: 4,
                cursor: 'pointer',
              }}
            >
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
              {s.name}
            </label>
          ))}
          {filtered.length === 0 && (
            <span style={{ fontSize: 13, color: tokens.color.textMuted }}>No matches.</span>
          )}
        </div>

        {isGroup && (
          <div>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              Group name (optional)
            </span>
            <input
              style={inputStyle}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Tax Team"
            />
          </div>
        )}
        <div>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
            First message (optional)
          </span>
          <textarea
            style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={busy || selected.size === 0}>
            {busy ? 'Starting…' : isGroup ? 'Start group' : 'Start chat'}
          </Button>
        </div>
      </div>
    </div>
  );
}
