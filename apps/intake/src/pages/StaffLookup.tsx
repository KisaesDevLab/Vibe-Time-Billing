// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Landing route: the visitor picks the staff member to send documents to.
// Phase B renders the shell + a live API reachability check so we can
// confirm the ingress wiring end-to-end. Phase C replaces this with the
// real staff-card grid (GET /staff) and links each card to /:staffId.

import { useEffect, useState } from 'react';

import { tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';

interface HealthResponse {
  ok: boolean;
}

export function StaffLookup(): JSX.Element {
  const [status, setStatus] = useState<'checking' | 'ready' | 'down'>('checking');

  useEffect(() => {
    let alive = true;
    api<HealthResponse>('/health')
      .then((r) => {
        if (alive) setStatus(r.ok ? 'ready' : 'down');
      })
      .catch((_err: ApiError) => {
        if (alive) setStatus('down');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Choose your contact</h2>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        Select the person at the firm you&apos;re working with. The document upload form is coming
        next.
      </p>
      <div
        style={{
          padding: 12,
          borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.color.border}`,
          fontSize: 13,
          color:
            status === 'ready'
              ? tokens.color.success
              : status === 'down'
                ? tokens.color.danger
                : tokens.color.textMuted,
        }}
      >
        {status === 'checking' && 'Connecting…'}
        {status === 'ready' && 'Connected. The intake service is online.'}
        {status === 'down' &&
          'The intake service is not reachable right now. Please try again later.'}
      </div>
    </div>
  );
}
