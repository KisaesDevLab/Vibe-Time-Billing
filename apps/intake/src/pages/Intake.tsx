// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Per-staff upload route (/:staffId). Phase B is a placeholder; Phase C
// adds the recipient form, desktop file upload, and PWA document scanner.

import { useParams, Link } from 'react-router-dom';

import { tokens } from '@vibe/ui';

export function Intake(): JSX.Element {
  const { staffId } = useParams<{ staffId: string }>();
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Send documents</h2>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        Upload for contact <code>{staffId}</code>. The upload form is coming soon.
      </p>
      <Link to="/" style={{ fontSize: 13, color: tokens.color.accent }}>
        ← Choose a different contact
      </Link>
    </div>
  );
}
