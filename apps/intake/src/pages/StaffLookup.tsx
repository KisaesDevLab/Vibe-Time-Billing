// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Landing route: the visitor picks the staff member to send documents to.
// Renders the visible staff-card grid (GET /staff); each card links to the
// per-staff upload form at /:staffId. This is step 1 (Contact) of the wizard.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type ApiError } from '../api-client';
import {
  Stepper,
  TrustFooter,
  cardShadow,
  cardStyle,
  headFont,
  headingStyle,
  palette,
  subheadStyle,
} from '../ui';

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

const STEPS = [
  { n: 1, label: 'Contact' },
  { n: 2, label: 'Details' },
  { n: 3, label: 'Send' },
];

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
    return <p style={{ fontSize: 14, color: palette.muted }}>Loading…</p>;
  }
  if (state.kind === 'unavailable') {
    return (
      <p style={{ fontSize: 15, color: palette.text }}>
        Online document intake isn&apos;t available right now. Please contact the firm directly.
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p style={{ fontSize: 15, color: palette.danger }}>
        Something went wrong loading this page. Please refresh and try again.
      </p>
    );
  }
  if (state.staff.length === 0) {
    return (
      <p style={{ fontSize: 15, color: palette.text }}>
        No one at the firm is currently accepting documents online. Please contact your firm
        directly.
      </p>
    );
  }

  return (
    <div style={cardStyle}>
      <Stepper steps={STEPS} current={1} />

      <div style={{ marginTop: 24 }}>
        <h2 style={headingStyle()}>Who are you sending to?</h2>
        <p style={subheadStyle}>Choose the person at the firm you&apos;re working with.</p>
      </div>

      <div
        style={{
          marginTop: 22,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))',
          gap: 13,
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
              gap: 10,
              padding: '20px 14px',
              textAlign: 'center',
              textDecoration: 'none',
              color: palette.ink,
              background: '#fff',
              border: `1px solid ${palette.border}`,
              borderRadius: 16,
              boxShadow: cardShadow,
            }}
          >
            <Avatar name={s.name} hasHeadshot={s.hasHeadshot} id={s.id} />
            <span
              style={{ fontFamily: headFont, fontWeight: 600, fontSize: 15.5, color: palette.ink }}
            >
              {s.name}
            </span>
            {s.title && <span style={{ fontSize: 13, color: palette.muted }}>{s.title}</span>}
          </Link>
        ))}
      </div>

      <div style={{ marginTop: 24 }}>
        <TrustFooter />
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
  const size = 56;
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
        background: palette.accentSoft2,
        color: palette.accent,
        fontFamily: headFont,
        fontWeight: 700,
        fontSize: 20,
      }}
    >
      {initials || '?'}
    </span>
  );
}
