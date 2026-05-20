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
  brandDisplayName: string | null;
  brandLogoUrl: string | null;
  brandAccentColor: string | null;
  brandSupportEmail: string | null;
  brandSupportPhone: string | null;
  brandFooterHtml: string | null;
}

export function FirmSettingsPage(): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
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
          brandDisplayName: s.brandDisplayName || null,
          brandLogoUrl: s.brandLogoUrl || null,
          brandAccentColor: s.brandAccentColor || null,
          brandSupportEmail: s.brandSupportEmail || null,
          brandSupportPhone: s.brandSupportPhone || null,
          brandFooterHtml: s.brandFooterHtml || null,
        }),
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  if (!s) return <p style={{ color: tokens.color.danger }}>{error ?? 'Settings unavailable'}</p>;

  return (
    <form onSubmit={save} style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 720 }}>
      <Card
        title="Firm settings"
        action={
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
            locked decisions from QUESTIONS.md
          </span>
        }
      >
        <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
          <Input
            label="Adjustment approval threshold (cents) — Q27"
            type="number"
            value={s.adjustmentApprovalThresholdCents}
            onChange={(e) =>
              setS({ ...s, adjustmentApprovalThresholdCents: Number(e.target.value) })
            }
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
        </div>
      </Card>

      <Card title="Branding">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Used on invoice PDFs, the client portal header, and dunning emails.
        </p>
        <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <Input
            label="Display name"
            value={s.brandDisplayName ?? ''}
            onChange={(e) => setS({ ...s, brandDisplayName: e.target.value })}
            placeholder="Smith & Associates, CPA"
          />
          <Input
            label="Logo URL"
            type="url"
            value={s.brandLogoUrl ?? ''}
            onChange={(e) => setS({ ...s, brandLogoUrl: e.target.value })}
            placeholder="https://cdn.example.com/logo.png"
          />
          <Input
            label="Accent color (hex)"
            value={s.brandAccentColor ?? ''}
            onChange={(e) => setS({ ...s, brandAccentColor: e.target.value })}
            placeholder="#0f6cbd"
          />
          <Input
            label="Support email"
            type="email"
            value={s.brandSupportEmail ?? ''}
            onChange={(e) => setS({ ...s, brandSupportEmail: e.target.value })}
            placeholder="billing@firm.com"
          />
          <Input
            label="Support phone"
            value={s.brandSupportPhone ?? ''}
            onChange={(e) => setS({ ...s, brandSupportPhone: e.target.value })}
            placeholder="(555) 555-5555"
          />
          <label style={{ fontSize: 13 }}>
            Footer HTML (rendered on invoice PDFs)
            <textarea
              value={s.brandFooterHtml ?? ''}
              onChange={(e) => setS({ ...s, brandFooterHtml: e.target.value })}
              rows={3}
              style={{
                marginTop: 4,
                width: '100%',
                fontFamily: 'monospace',
                fontSize: 12,
                padding: 8,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
            />
          </label>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {savedAt && (
          <span style={{ fontSize: 12, color: tokens.color.success }}>
            Saved at {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      </div>
    </form>
  );
}
