// SPDX-License-Identifier: Elastic-2.0
import { useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../../api-client';

export function BackupPage(): JSX.Element {
  const [marker, setMarker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function trigger(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ marker: string }>('/api/staff/admin/backup/trigger', {
        method: 'POST',
        body: '{}',
      });
      setMarker(r.marker);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 700 }}>
      <Card title="Backups">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Backups are produced by a nightly cron inside the appliance (Q12). This panel records a
          manual-trigger marker that the ops script reads to differentiate one-off backups from the
          scheduled run.
        </p>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          Default retention: 30 days under <code>/backups</code> on the appliance host.
        </p>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          For restore: see <code>ops/docs/restore.md</code> in the repo.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Button onClick={() => void trigger()} disabled={busy}>
            {busy ? 'Triggering…' : 'Trigger backup marker'}
          </Button>
          {marker && <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{marker}</code>}
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>
    </div>
  );
}
