// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useMemo, useState } from 'react';

import { tokens } from '@vibe/ui';

import { api } from './api-client';

interface Hit {
  kind: 'client' | 'engagement' | 'invoice' | 'user';
  id: string;
  label: string;
  href: string;
}

const KIND_LABEL: Record<Hit['kind'], string> = {
  client: 'Client',
  engagement: 'Engagement',
  invoice: 'Invoice',
  user: 'User',
};

export function QuickFind(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open || q.length < 2) {
      setHits([]);
      return;
    }
    const ctl = new AbortController();
    void (async () => {
      try {
        const r = await api<{ items: Hit[] }>(
          `/api/staff/search/quick-find?q=${encodeURIComponent(q)}`,
        );
        if (!ctl.signal.aborted) {
          setHits(r.items ?? []);
          setActive(0);
        }
      } catch {
        if (!ctl.signal.aborted) setHits([]);
      }
    })();
    return () => ctl.abort();
  }, [q, open]);

  const total = useMemo(() => hits.length, [hits]);

  if (!open) return null;

  function pick(i: number): void {
    const h = hits[i];
    if (!h) return;
    setOpen(false);
    window.location.href = h.href;
  }

  return (
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick find"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 80,
        zIndex: 1000,
      }}
    >
      <div
        role="presentation"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          width: 560,
          maxHeight: 480,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          border: `1px solid ${tokens.color.border}`,
        }}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, total - 1));
            if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            if (e.key === 'Enter') pick(active);
          }}
          placeholder="Search clients, engagements, invoices, users…"
          style={{
            padding: '14px 18px',
            border: 'none',
            outline: 'none',
            fontSize: 16,
            background: 'transparent',
            color: tokens.color.text,
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        />
        <div style={{ overflowY: 'auto' }}>
          {hits.length === 0 && q.length >= 2 ? (
            <p style={{ padding: 16, fontSize: 13, color: tokens.color.textMuted }}>No matches.</p>
          ) : (
            hits.map((h, i) => (
              <button
                type="button"
                key={`${h.kind}-${h.id}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
                style={{
                  padding: '10px 18px',
                  cursor: 'pointer',
                  background: i === active ? tokens.color.accent + '20' : 'transparent',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 13,
                  borderBottom: `1px solid ${tokens.color.border}`,
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  color: tokens.color.text,
                }}
              >
                <span>{h.label}</span>
                <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {KIND_LABEL[h.kind]}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
