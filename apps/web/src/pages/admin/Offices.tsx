// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Office {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
  isDefault: boolean;
}

interface OverrideShape {
  adjustmentApprovalThresholdCents: number | null;
  timeEntryRoundingHours: string | null;
  lateEntryAlertDays: number | null;
  lateEntryLockoutDays: number | null;
  invoiceNumberingPrefix: string | null;
}

interface SettingsView {
  override: OverrideShape | null;
  resolved: OverrideShape | null;
}

export function OfficesPage(): JSX.Element {
  const [offices, setOffices] = useState<Office[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [tz, setTz] = useState('America/Chicago');
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ offices: Office[] }>('/api/staff/admin/offices');
      setOffices(r.offices ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/staff/admin/offices', {
        method: 'POST',
        body: JSON.stringify({ name, timezone: tz }),
      });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Add office">
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)} required />
          <Button type="submit">Add</Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Offices">
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<Office>
            columns={[
              { key: 'name', header: 'Name', render: (o) => o.name },
              { key: 'tz', header: 'Timezone', render: (o) => o.timezone },
              {
                key: 'default',
                header: 'Default',
                render: (o) => (o.isDefault ? <Pill tone="accent">default</Pill> : null),
              },
              {
                key: 'actions',
                header: '',
                render: (o) => (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setActiveId(activeId === o.id ? null : o.id)}
                  >
                    {activeId === o.id ? 'Hide' : 'Settings'}
                  </Button>
                ),
              },
            ]}
            rows={offices}
            rowKey={(o) => o.id}
            empty="No offices yet."
          />
        )}
      </Card>

      {activeId && <OfficeSettingsPanel officeId={activeId} />}
    </div>
  );
}

function OfficeSettingsPanel({ officeId }: { officeId: string }): JSX.Element {
  const [data, setData] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load(): Promise<void> {
    setError(null);
    try {
      const r = await api<SettingsView>(`/api/staff/admin/offices/${officeId}/settings`);
      setData(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeId]);

  async function save(field: keyof OverrideShape, value: number | string | null): Promise<void> {
    setError(null);
    setSaved(false);
    try {
      await api(`/api/staff/admin/offices/${officeId}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: value }),
      });
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  if (!data) {
    return (
      <Card title="Office settings">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      </Card>
    );
  }
  const ov = data.override ?? ({} as OverrideShape);
  const res = data.resolved ?? ({} as OverrideShape);

  return (
    <Card title="Office settings override">
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      {saved && (
        <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>Saved.</p>
      )}
      <div style={{ display: 'grid', gap: 12 }}>
        <OverrideRow
          label="Adjustment approval threshold (cents)"
          field="adjustmentApprovalThresholdCents"
          ov={ov}
          res={res}
          onSave={save}
        />
        <OverrideRow
          label="Time entry rounding (hours)"
          field="timeEntryRoundingHours"
          kind="text"
          ov={ov}
          res={res}
          onSave={save}
        />
        <OverrideRow
          label="Late-entry alert days"
          field="lateEntryAlertDays"
          ov={ov}
          res={res}
          onSave={save}
        />
        <OverrideRow
          label="Late-entry lockout days"
          field="lateEntryLockoutDays"
          ov={ov}
          res={res}
          onSave={save}
        />
        <OverrideRow
          label="Invoice numbering prefix"
          field="invoiceNumberingPrefix"
          kind="text"
          ov={ov}
          res={res}
          onSave={save}
        />
      </div>
    </Card>
  );
}

function OverrideRow({
  label,
  field,
  kind = 'number',
  ov,
  res,
  onSave,
}: {
  label: string;
  field: keyof OverrideShape;
  kind?: 'number' | 'text';
  ov: OverrideShape;
  res: OverrideShape;
  onSave: (field: keyof OverrideShape, value: number | string | null) => Promise<void>;
}): JSX.Element {
  const ovVal = ov[field];
  const resVal = res[field];
  const [draft, setDraft] = useState<string>(ovVal == null ? '' : String(ovVal));
  const [pending, setPending] = useState(false);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr auto auto',
        gap: 8,
        alignItems: 'end',
      }}
    >
      <div>
        <div style={{ fontSize: 12, color: tokens.color.textMuted }}>{label}</div>
        <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
          Effective: {resVal == null ? '—' : String(resVal)}
        </div>
      </div>
      <input
        type={kind === 'number' ? 'number' : 'text'}
        value={draft}
        placeholder="(inherit)"
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        style={{
          padding: '8px 10px',
          background: tokens.color.surface,
          color: tokens.color.text,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          fontSize: 13,
        }}
      />
      <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>
        {ovVal == null ? 'inheriting' : 'overridden'}
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          const v = draft.trim();
          const parsed: number | string | null =
            v === '' ? null : kind === 'number' ? Number(v) : v;
          setPending(true);
          try {
            await onSave(field, parsed);
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={async () => {
          setDraft('');
          setPending(true);
          try {
            await onSave(field, null);
          } finally {
            setPending(false);
          }
        }}
      >
        Clear
      </Button>
    </div>
  );
}
