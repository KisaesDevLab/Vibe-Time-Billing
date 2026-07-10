// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Snapshot {
  firmId: string;
  firmName: string;
  createdAt: string;
  counts: {
    clients: number;
    engagements: number;
    invoices: number;
    users: number;
    recurringPlans: number;
  };
  generatedAt: string;
}

export function CompliancePage(): JSX.Element {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ snapshot: Snapshot | null }>(
          '/api/staff/admin/compliance/firm-snapshot',
        );
        setSnap(r.snapshot);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  async function downloadWisp(): Promise<void> {
    const resp = await fetch('/api/staff/admin/compliance/wisp-template');
    const text = await resp.text();
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wisp-template.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 800 }}>
      <Card title="Firm snapshot">
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {snap && (
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '6px 16px',
              fontSize: 13,
              margin: 0,
            }}
          >
            <dt style={{ color: tokens.color.textMuted }}>Firm</dt>
            <dd style={{ margin: 0 }}>
              {snap.firmName} <code style={{ fontSize: 11 }}>{snap.firmId.slice(0, 8)}…</code>
            </dd>
            <dt style={{ color: tokens.color.textMuted }}>Clients</dt>
            <dd style={{ margin: 0 }}>{snap.counts.clients.toLocaleString()}</dd>
            <dt style={{ color: tokens.color.textMuted }}>Engagements</dt>
            <dd style={{ margin: 0 }}>{snap.counts.engagements.toLocaleString()}</dd>
            <dt style={{ color: tokens.color.textMuted }}>Invoices</dt>
            <dd style={{ margin: 0 }}>{snap.counts.invoices.toLocaleString()}</dd>
            <dt style={{ color: tokens.color.textMuted }}>Users</dt>
            <dd style={{ margin: 0 }}>{snap.counts.users.toLocaleString()}</dd>
            <dt style={{ color: tokens.color.textMuted }}>Recurring plans</dt>
            <dd style={{ margin: 0 }}>{snap.counts.recurringPlans.toLocaleString()}</dd>
          </dl>
        )}
      </Card>

      <Card title="Compliance documents">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          WISP starter template — adapt to your firm. Stored externally; not retained by the
          appliance after download.
        </p>
        <Button onClick={() => void downloadWisp()}>Download WISP template (Markdown)</Button>
      </Card>
    </div>
  );
}
