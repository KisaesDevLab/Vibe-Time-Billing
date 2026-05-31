// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0083 — Admin page for recurring engagements. Lists firm
// recurrences + lets staff create / pause / resume / cancel / run-now.
//
// Backed by /api/staff/engagement-recurrences. Worker
// (apps/worker/src/jobs/recurring-engagement.ts) does the daily 02:45
// sweep that spawns the next engagement per row.

import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';
import type { ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';

interface RecurrenceRow {
  id: string;
  clientId: string;
  clientName: string;
  templateId: string;
  templateName: string;
  templateNamePattern: string | null;
  frequency: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
  triggerMode: 'SCHEDULE' | 'ON_COMPLETION';
  nextRunDate: string | null;
  seedPeriodYear: number | null;
  seedPeriodMonth: number | null;
  seedPeriodLabel: string | null;
  lastEngagementId: string | null;
  lastRunAt: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  notes: string | null;
  createdAt: string;
}

interface ClientLite {
  id: string;
  name: string;
}
interface TemplateLite {
  id: string;
  name: string;
  namePattern: string | null;
  status: string;
}

const FREQUENCY_OPTIONS: ComboboxOption[] = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Bi-weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'SEMIANNUAL', label: 'Semi-annual' },
  { value: 'ANNUAL', label: 'Annual' },
];

const TRIGGER_OPTIONS: ComboboxOption[] = [
  { value: 'SCHEDULE', label: 'On schedule (date-based)' },
  { value: 'ON_COMPLETION', label: 'When previous engagement is closed' },
];

function statusTone(s: RecurrenceRow['status']): 'success' | 'warning' | 'neutral' {
  if (s === 'ACTIVE') return 'success';
  if (s === 'PAUSED') return 'warning';
  return 'neutral';
}

export function EngagementRecurrencesPage(): JSX.Element {
  const [rows, setRows] = useState<RecurrenceRow[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [templates, setTemplates] = useState<TemplateLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [draftClientId, setDraftClientId] = useState('');
  const [draftTemplateId, setDraftTemplateId] = useState('');
  const [draftFrequency, setDraftFrequency] = useState<RecurrenceRow['frequency']>('MONTHLY');
  const [draftTriggerMode, setDraftTriggerMode] =
    useState<RecurrenceRow['triggerMode']>('SCHEDULE');
  const [draftNextRunDate, setDraftNextRunDate] = useState('');
  const [draftSeedYear, setDraftSeedYear] = useState('');
  const [draftSeedMonth, setDraftSeedMonth] = useState('');
  const [draftSeedLabel, setDraftSeedLabel] = useState('');
  const [draftNotes, setDraftNotes] = useState('');

  async function load(): Promise<void> {
    setError(null);
    try {
      const [r, c, t] = await Promise.all([
        api<{ items: RecurrenceRow[] }>('/api/staff/engagement-recurrences'),
        api<{ items: ClientLite[] }>('/api/staff/clients').catch(() => ({ items: [] })),
        api<{ items: TemplateLite[] }>('/api/staff/admin/templates/engagement').catch(() => ({
          items: [],
        })),
      ]);
      setRows(r.items ?? []);
      setClients(c.items ?? []);
      setTemplates((t.items ?? []).filter((x) => x.status === 'ACTIVE'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function resetForm(): void {
    setDraftClientId('');
    setDraftTemplateId('');
    setDraftFrequency('MONTHLY');
    setDraftTriggerMode('SCHEDULE');
    setDraftNextRunDate('');
    setDraftSeedYear('');
    setDraftSeedMonth('');
    setDraftSeedLabel('');
    setDraftNotes('');
  }

  async function create(): Promise<void> {
    if (!draftClientId || !draftTemplateId) {
      setError('Client and template are required.');
      return;
    }
    if (draftTriggerMode === 'SCHEDULE' && !draftNextRunDate) {
      setError('First run date is required for schedule-based recurrences.');
      return;
    }
    const body: Record<string, unknown> = {
      clientId: draftClientId,
      templateId: draftTemplateId,
      frequency: draftFrequency,
      triggerMode: draftTriggerMode,
    };
    if (draftTriggerMode === 'SCHEDULE') body.nextRunDate = draftNextRunDate;
    if (draftSeedYear.trim()) body.seedPeriodYear = Number(draftSeedYear);
    if (draftSeedMonth.trim()) body.seedPeriodMonth = Number(draftSeedMonth);
    if (draftSeedLabel.trim()) body.seedPeriodLabel = draftSeedLabel.trim();
    if (draftNotes.trim()) body.notes = draftNotes.trim();
    try {
      await api('/api/staff/engagement-recurrences', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      resetForm();
      setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create_failed');
    }
  }

  async function pauseResume(row: RecurrenceRow): Promise<void> {
    setBusy(row.id);
    try {
      await api(`/api/staff/engagement-recurrences/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: row.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'patch_failed');
    } finally {
      setBusy(null);
    }
  }

  async function cancel(row: RecurrenceRow): Promise<void> {
    if (
      !window.confirm(
        `Cancel the recurring "${row.templateName}" for ${row.clientName}? The row stays for audit history but no more engagements will spawn.`,
      )
    )
      return;
    setBusy(row.id);
    try {
      await api(`/api/staff/engagement-recurrences/${row.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete_failed');
    } finally {
      setBusy(null);
    }
  }

  async function runNow(row: RecurrenceRow): Promise<void> {
    setBusy(row.id);
    try {
      const r = await api<{ kind: string; engagementId?: string }>(
        `/api/staff/engagement-recurrences/${row.id}/run-now`,
        { method: 'POST' },
      );
      if (r.kind === 'spawned') {
        await load();
        window.alert(`Spawned engagement ${r.engagementId ?? ''}`);
      } else if (r.kind === 'approval_queued') {
        window.alert(
          'Previous engagement is still active. An approval row has been queued for the partner.',
        );
        await load();
      } else if (r.kind === 'skipped') {
        window.alert('Skipped (recurrence is paused or cancelled).');
      } else {
        window.alert(`Run-now returned ${r.kind}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'run_failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title="Recurring engagements"
        action={
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ New recurrence'}
          </Button>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}

        {showForm && (
          <div
            style={{
              padding: tokens.space.md,
              marginBottom: tokens.space.md,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              display: 'grid',
              gap: tokens.space.sm,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.sm }}>
              <div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Client *
                </div>
                <Combobox
                  ariaLabel="Client"
                  value={draftClientId}
                  onChange={setDraftClientId}
                  options={clients.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="— select —"
                />
              </div>
              <div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Template *
                </div>
                <Combobox
                  ariaLabel="Template"
                  value={draftTemplateId}
                  onChange={setDraftTemplateId}
                  options={templates.map((t) => ({
                    value: t.id,
                    label: t.name,
                    description: t.namePattern ?? undefined,
                  }))}
                  placeholder="— select —"
                />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.sm }}>
              <div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Frequency
                </div>
                <Combobox
                  ariaLabel="Frequency"
                  value={draftFrequency}
                  onChange={(v) => setDraftFrequency(v as RecurrenceRow['frequency'])}
                  options={FREQUENCY_OPTIONS}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Trigger
                </div>
                <Combobox
                  ariaLabel="Trigger mode"
                  value={draftTriggerMode}
                  onChange={(v) => setDraftTriggerMode(v as RecurrenceRow['triggerMode'])}
                  options={TRIGGER_OPTIONS}
                />
              </div>
            </div>
            {draftTriggerMode === 'SCHEDULE' && (
              <Input
                type="date"
                label="First run date *"
                value={draftNextRunDate}
                onChange={(e) => setDraftNextRunDate(e.target.value)}
              />
            )}
            <div>
              <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                Seed period (used for the FIRST run only)
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 2fr',
                  gap: tokens.space.sm,
                }}
              >
                <Input
                  type="number"
                  min={1900}
                  max={9999}
                  label="Year"
                  value={draftSeedYear}
                  onChange={(e) => setDraftSeedYear(e.target.value)}
                  placeholder="2026"
                />
                <div>
                  <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                    Month
                  </div>
                  <Combobox
                    ariaLabel="Seed month"
                    clearable
                    value={draftSeedMonth}
                    onChange={(v) => setDraftSeedMonth(v ?? '')}
                    options={Array.from({ length: 12 }, (_, i) => ({
                      value: String(i + 1),
                      label: new Date(2000, i, 1).toLocaleString('en-US', { month: 'long' }),
                    }))}
                    placeholder="—"
                  />
                </div>
                <Input
                  label="Label"
                  value={draftSeedLabel}
                  onChange={(e) => setDraftSeedLabel(e.target.value)}
                  placeholder="e.g. Q1 2026"
                />
              </div>
            </div>
            <Input
              label="Notes"
              value={draftNotes}
              onChange={(e) => setDraftNotes(e.target.value)}
              placeholder="Internal note (optional)"
            />
            <div>
              <Button onClick={() => void create()}>Create recurrence</Button>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No recurrences yet. Click <em>+ New recurrence</em> above to set one up.
          </p>
        ) : (
          <Table<RecurrenceRow>
            columns={[
              { key: 'client', header: 'Client', render: (r) => r.clientName },
              {
                key: 'template',
                header: 'Template',
                render: (r) => (
                  <span>
                    {r.templateName}
                    {r.templateNamePattern && (
                      <span
                        style={{
                          display: 'block',
                          fontSize: 11,
                          color: tokens.color.textMuted,
                          fontFamily: 'monospace',
                        }}
                      >
                        {r.templateNamePattern}
                      </span>
                    )}
                  </span>
                ),
              },
              { key: 'freq', header: 'Frequency', render: (r) => r.frequency },
              {
                key: 'trigger',
                header: 'Trigger',
                render: (r) =>
                  r.triggerMode === 'SCHEDULE'
                    ? `Schedule (${r.nextRunDate ?? '—'})`
                    : 'Completion',
              },
              {
                key: 'last',
                header: 'Last ran',
                render: (r) => (r.lastRunAt ? new Date(r.lastRunAt).toLocaleDateString() : '—'),
              },
              {
                key: 'status',
                header: 'Status',
                render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
              },
              {
                key: 'actions',
                header: '',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {r.status !== 'CANCELLED' && (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === r.id}
                          onClick={() => void runNow(r)}
                        >
                          Run now
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === r.id}
                          onClick={() => void pauseResume(r)}
                        >
                          {r.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === r.id}
                          onClick={() => void cancel(r)}
                        >
                          Cancel
                        </Button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            empty="No recurrences."
          />
        )}
      </Card>
    </div>
  );
}
