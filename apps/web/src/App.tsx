// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { Routes, Route, Navigate } from 'react-router-dom';

import { Pill, tokens } from '@vibe/ui';

export function App(): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        padding: tokens.space.xl,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Vibe Time &amp; Billing</h1>
        <Pill tone="accent">staff</Pill>
      </header>
      <main style={{ marginTop: tokens.space.xl }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Home(): JSX.Element {
  return (
    <section>
      <p style={{ color: tokens.color.textMuted }}>
        Phase 1 scaffold. Subsequent phases populate the staff UI.
      </p>
    </section>
  );
}
