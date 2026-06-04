// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Tokenized "send-a-link" entry (/t/:token). A staff member emails/texts a
// recipient a one-time link that pre-binds the target staff member (and may
// pre-fill the recipient's contact). Phase B is a placeholder; Phase C
// resolves the token and renders the bound upload form.

import { useParams } from 'react-router-dom';

import { tokens } from '@vibe/ui';

export function Token(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Secure upload link</h2>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        {token
          ? 'Validating your secure link…'
          : 'This link is missing its token. Please use the full link from your email or text.'}
      </p>
    </div>
  );
}
