// SPDX-License-Identifier: Elastic-2.0
//
// Tokenized "send-a-link" entry (/t/:token). Resolves the token to a bound
// staff member, then renders the shared upload form (passing the token so
// the session is recorded as source=tokenized_link).

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';
import { UploadForm } from '../components/UploadForm';

interface Resolved {
  targetStaffId: string;
  staffName: string | null;
}

export function Token(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<'loading' | 'invalid' | Resolved>('loading');

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    let alive = true;
    api<Resolved>(`/link/${encodeURIComponent(token)}`)
      .then((r) => {
        if (alive) setState(r);
      })
      .catch((_err: ApiError) => {
        if (alive) setState('invalid');
      });
    return () => {
      alive = false;
    };
  }, [token]);

  if (state === 'loading') {
    return <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Validating your link…</p>;
  }
  if (state === 'invalid') {
    return (
      <p style={{ fontSize: 14 }}>
        This link is invalid or has expired. Please ask the firm to send you a new one.
      </p>
    );
  }
  return (
    <UploadForm targetStaffId={state.targetStaffId} staffName={state.staffName} linkToken={token} />
  );
}
