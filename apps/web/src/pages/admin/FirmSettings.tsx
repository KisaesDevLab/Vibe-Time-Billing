// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Settings {
  adjustmentApprovalThresholdCents: number;
  aiMonthlyBudgetCents: number;
  stepUpTimeoutMinutes: number;
  portalEnabled: boolean;
  timeEntryRoundingHours: string;
}

export function FirmSettingsPage(): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ settings: Settings }>('/api/staff/admin/firm-settings');
        setS(r.settings);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!s) return;
    setSaving(true);
    setError(null);
    try {
      await api('/api/staff/admin/firm-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          adjustmentApprovalThresholdCents: s.adjustmentApprovalThresholdCents,
          aiMonthlyBudgetCents: s.aiMonthlyBudgetCents,
          stepUpTimeoutMinutes: s.stepUpTimeoutMinutes,
          portalEnabled: s.portalEnabled,
        }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  if (!s) return <p style={{ color: tokens.color.danger }}>{error ?? 'Settings unavailable'}</p>;

  return (
    <Card
      title="Firm settings"
      action={
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          locked decisions from QUESTIONS.md
        </span>
      }
    >
      <form onSubmit={save} style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
        <Input
          label="Adjustment approval threshold (cents) — Q27"
          type="number"
          value={s.adjustmentApprovalThresholdCents}
          onChange={(e) => setS({ ...s, adjustmentApprovalThresholdCents: Number(e.target.value) })}
        />
        <Input
          label="AI monthly budget (cents) — Q14"
          type="number"
          value={s.aiMonthlyBudgetCents}
          onChange={(e) => setS({ ...s, aiMonthlyBudgetCents: Number(e.target.value) })}
        />
        <Input
          label="Step-up TOTP timeout (minutes) — Q4"
          type="number"
          value={s.stepUpTimeoutMinutes}
          onChange={(e) => setS({ ...s, stepUpTimeoutMinutes: Number(e.target.value) })}
        />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          <input
            type="checkbox"
            checked={s.portalEnabled}
            onChange={(e) => setS({ ...s, portalEnabled: e.target.checked })}
          />
          Portal enabled
        </label>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      </form>
    </Card>
  );
}
