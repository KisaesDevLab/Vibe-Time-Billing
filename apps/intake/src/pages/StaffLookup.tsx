// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Landing route: the visitor picks the staff member to send documents to.
// Renders the visible staff-card grid (GET /staff); each card links to the
// per-staff upload form at /:staffId.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';

interface StaffCard {
  id: string;
  name: string;
  title: string | null;
  hasHeadshot: boolean;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; staff: StaffCard[] }
  | { kind: 'unavailable' }
  | { kind: 'error' };

export function StaffLookup(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    api<{ staff: StaffCard[] }>('/staff')
      .then((r) => {
        if (alive) setState({ kind: 'ready', staff: r.staff });
      })
      .catch((err: ApiError) => {
        if (!alive) return;
        // 404 = feature off / not provisioned. Don't leak which.
        setState(err.status === 404 ? { kind: 'unavailable' } : { kind: 'error' });
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === 'loading') {
    return <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>;
  }
  if (state.kind === 'unavailable') {
    return (
      <p style={{ fontSize: 14 }}>
        Online document intake isn&apos;t available right now. Please contact the firm directly.
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p style={{ fontSize: 14, color: tokens.color.danger }}>
        Something went wrong loading this page. Please refresh and try again.
      </p>
    );
  }
  if (state.staff.length === 0) {
    return (
      <p style={{ fontSize: 14 }}>
        No one at the firm is currently accepting documents online. Please contact your firm
        directly.
      </p>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Choose your contact</h2>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        Select the person at the firm you&apos;re working with.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {state.staff.map((s) => (
          <Link
            key={s.id}
            to={`/${s.id}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              padding: 16,
              textAlign: 'center',
              textDecoration: 'none',
              color: tokens.color.text,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
            }}
          >
            <Avatar name={s.name} hasHeadshot={s.hasHeadshot} id={s.id} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</span>
            {s.title && (
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{s.title}</span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Avatar({
  name,
  hasHeadshot,
  id,
}: {
  name: string;
  hasHeadshot: boolean;
  id: string;
}): JSX.Element {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  const size = 64;
  const common: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    objectFit: 'cover',
  };
  if (hasHeadshot) {
    return (
      <img
        src={`/api/public/intake/staff/${id}/headshot`}
        alt={name}
        style={common}
        loading="lazy"
      />
    );
  }
  return (
    <span
      style={{
        ...common,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.color.accentMuted,
        color: tokens.color.accent,
        fontWeight: 700,
        fontSize: 22,
      }}
    >
      {initials || '?'}
    </span>
  );
}
