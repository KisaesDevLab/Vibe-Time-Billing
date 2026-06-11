// SPDX-License-Identifier: Elastic-2.0
//
// Typeahead over the firm-wide person directory. As staff type a name or
// email, matching firm people drop down — picking one links that EXISTING
// person (so the add-contact / invite flows reuse the directory record
// instead of spawning a duplicate). Typing an unmatched name and pressing
// the form's submit button creates a new person as before.
//
// Backed by GET /api/staff/people?q=&clientId= (the clientId annotates each
// result with onThisClient / alsoOn for context).

import { useEffect, useRef, useState } from 'react';

import { tokens } from '@vibe/ui';

import { api } from '../../api-client';

export interface PersonSearchResult {
  key: string;
  kind: 'person' | 'portal_identity';
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  onThisClient?: boolean;
  alsoOn?: { clientId: string; name: string }[];
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  width: '100%',
  boxSizing: 'border-box',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

export function PersonSearchField({
  clientId,
  value,
  onChangeText,
  onSelectPerson,
  placeholder,
  personOnly = true,
}: {
  clientId: string;
  value: string;
  onChangeText: (v: string) => void;
  onSelectPerson: (p: PersonSearchResult | null) => void;
  placeholder?: string;
  /** Only allow selecting directory people (kind 'person') — the default,
   * since linking requires a person row. Portal-only identities are shown
   * disabled. */
  personOnly?: boolean;
}): JSX.Element {
  const [results, setResults] = useState<PersonSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      const params = new URLSearchParams({ q, pageSize: '8' });
      if (clientId) params.set('clientId', clientId);
      api<{ rows: PersonSearchResult[] }>(`/api/staff/people?${params.toString()}`)
        .then((r) => {
          if (!alive) return;
          setResults(r.rows ?? []);
          setOpen(true);
        })
        .catch(() => {
          if (alive) setResults([]);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value, clientId]);

  const selectable = (r: PersonSearchResult): boolean =>
    !r.onThisClient && (!personOnly || r.kind === 'person');

  return (
    <div style={{ position: 'relative' }}>
      <input
        style={fieldStyle}
        value={value}
        onChange={(e) => {
          onChangeText(e.target.value);
          onSelectPerson(null);
        }}
        onFocus={() => {
          if (results.length) setOpen(true);
        }}
        onBlur={() => {
          // Delay so an option's onMouseDown can win the click.
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        placeholder={placeholder ?? 'Full name *'}
        aria-label="Search people or type a new name"
        autoComplete="off"
      />
      {open && (loading || results.length > 0) && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 50,
            marginTop: 2,
            maxHeight: 260,
            overflowY: 'auto',
            background: tokens.color.bg,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
          }}
        >
          {loading && results.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: tokens.color.textMuted }}>
              Searching…
            </div>
          )}
          {results.map((r) => {
            const can = selectable(r);
            return (
              <button
                type="button"
                key={r.key}
                disabled={!can}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (!can) return;
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  onSelectPerson(r);
                  onChangeText(r.fullName);
                  setOpen(false);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: 'none',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  background: 'transparent',
                  color: tokens.color.text,
                  cursor: can ? 'pointer' : 'default',
                  opacity: can ? 1 : 0.6,
                  font: 'inherit',
                }}
              >
                <div style={{ fontSize: 13 }}>
                  {r.fullName}
                  {r.email ? (
                    <span style={{ color: tokens.color.textMuted }}> · {r.email}</span>
                  ) : null}
                </div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {r.onThisClient
                    ? 'Already on this client'
                    : personOnly && r.kind === 'portal_identity'
                      ? 'Portal-only login — promote from its client first'
                      : r.alsoOn && r.alsoOn.length > 0
                        ? `Also on: ${r.alsoOn.map((a) => a.name).join(', ')}`
                        : 'In the firm directory'}
                </div>
              </button>
            );
          })}
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              if (blurTimer.current) clearTimeout(blurTimer.current);
              onSelectPerson(null);
              setOpen(false);
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              border: 'none',
              background: 'transparent',
              color: tokens.color.accent,
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12,
            }}
          >
            + Create new “{value.trim() || '…'}”
          </button>
        </div>
      )}
    </div>
  );
}
