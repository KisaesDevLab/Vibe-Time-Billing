/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Per-client recurring-engagement card. Sits above the engagements
// table on the Engagements tab of ClientDetail. Two operations:
//
//   - Per-row "Run now" — calls POST /engagement-recurrences/:id/run-now
//     and spawns the next period engagement (or queues an approval if
//     the previous one is still ACTIVE — Q23 collision).
//
//   - "Run all due" header action — fires POST /engagement-recurrences/
//     bulk-run with every recurrence flagged isDue=true on this client.
//
// Also exposes a "+ Add recurrence" mode that mounts the shared
// RecurrenceComposer pre-scoped to this client, with a template
// dropdown the user must pick before POSTing.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

import {
  RecurrenceComposer,
  makeDefaultRecurrenceDraft,
  recurrenceDraftToPayload,
  type RecurrenceDraft,
  type RecurrenceFrequency,
  type RecurrenceSpawnStatus,
} from '../engagements/RecurrenceComposer';

interface RecurrenceRow {
  id: string;
  clientId: string;
  clientName: string;
  templateId: string;
  templateName: string;
  frequency: string;
  triggerMode: 'SCHEDULE' | 'ON_COMPLETION';
  nextRunDate: string | null;
  seedPeriodYear: number | null;
  seedPeriodMonth: number | null;
  seedPeriodLabel: string | null;
  spawnStatus: string | null;
  rollforwardAppointment: boolean;
  rollforwardDropoff: boolean;
  notes: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  lastEngagementId: string | null;
  lastEngagementName: string | null;
  lastEngagementStatus: string | null;
  isDue: boolean;
}

function rowToDraft(r: RecurrenceRow): RecurrenceDraft {
  return {
    frequency: r.frequency as RecurrenceFrequency,
    triggerMode: r.triggerMode,
    nextRunDate: r.nextRunDate ?? '',
    seedPeriodYear: r.seedPeriodYear != null ? String(r.seedPeriodYear) : '',
    seedPeriodMonth: r.seedPeriodMonth != null ? String(r.seedPeriodMonth) : '',
    seedPeriodLabel: r.seedPeriodLabel ?? '',
    spawnStatus: (r.spawnStatus ?? '') as '' | RecurrenceSpawnStatus,
    rollforwardAppointment: r.rollforwardAppointment,
    rollforwardDropoff: r.rollforwardDropoff,
    notes: r.notes ?? '',
  };
}

interface TemplateOption {
  id: string;
  name: string;
}

interface BulkResult {
  recurrenceId: string;
  kind: string;
  name?: string;
  engagementId?: string;
  reason?: string;
}

interface Props {
  clientId: string;
  // When rendered from an engagement's detail page, new recurrences are
  // back-pointed at that engagement so the first spawn advances from its
  // period (and the seed inputs are hidden).
  lastEngagementId?: string;
}

export function RecurringEngagementsCard({ clientId, lastEngagementId }: Props): JSX.Element {
  const [rows, setRows] = useState<RecurrenceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<{
    summary: Record<string, number>;
    items: BulkResult[];
  } | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [addTemplateId, setAddTemplateId] = useState('');
  const [addDraft, setAddDraft] = useState<RecurrenceDraft>(() => makeDefaultRecurrenceDraft());

  // Edit an existing recurrence (frequency, trigger, spawn status, rollforward
  // toggles, notes). The template itself is fixed once created.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<RecurrenceDraft | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: RecurrenceRow[] }>(
        `/api/staff/engagement-recurrences?clientId=${clientId}`,
      );
      setRows(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setRows([]);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Lazy-load the template list the first time the Add form opens.
  useEffect(() => {
    if (!showAdd || templates.length > 0) return;
    void (async () => {
      try {
        const r = await api<{ items: TemplateOption[] }>('/api/staff/admin/templates/engagement');
        setTemplates(r.items ?? []);
      } catch {
        // Empty list will produce a helpful UI error on submit.
      }
    })();
  }, [showAdd, templates.length]);

  async function runOne(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/staff/engagement-recurrences/${id}/run-now`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'run_failed');
    } finally {
      setBusy(null);
    }
  }

  async function runAllDue(): Promise<void> {
    if (!rows) return;
    const dueIds = rows.filter((r) => r.isDue).map((r) => r.id);
    if (dueIds.length === 0) return;
    setBusy('bulk');
    setError(null);
    setBulkResult(null);
    try {
      const r = await api<{
        results: BulkResult[];
        summary: Record<string, number>;
      }>('/api/staff/engagement-recurrences/bulk-run', {
        method: 'POST',
        body: JSON.stringify({ recurrenceIds: dueIds }),
      });
      setBulkResult({ summary: r.summary, items: r.results });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk_failed');
    } finally {
      setBusy(null);
    }
  }

  async function addRecurrence(): Promise<void> {
    if (!addTemplateId) {
      setError('Pick a template — the recurrence reuses it each period.');
      return;
    }
    setBusy('add');
    setError(null);
    try {
      await api('/api/staff/engagement-recurrences', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          templateId: addTemplateId,
          ...(lastEngagementId ? { lastEngagementId } : {}),
          ...recurrenceDraftToPayload(addDraft),
        }),
      });
      setShowAdd(false);
      setAddTemplateId('');
      setAddDraft(makeDefaultRecurrenceDraft());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'add_failed');
    } finally {
      setBusy(null);
    }
  }

  function startEdit(r: RecurrenceRow): void {
    setShowAdd(false);
    setEditDraft(rowToDraft(r));
    setEditingId(r.id);
    setError(null);
  }

  async function saveEdit(): Promise<void> {
    if (!editingId || !editDraft) return;
    setBusy(editingId);
    setError(null);
    try {
      await api(`/api/staff/engagement-recurrences/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify(recurrenceDraftToPayload(editDraft)),
      });
      setEditingId(null);
      setEditDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setBusy(null);
    }
  }

  const dueCount = (rows ?? []).filter((r) => r.isDue).length;

  return (
    <>
      <Card
        title="Recurring engagements"
        action={
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              variant={dueCount > 0 ? 'secondary' : 'ghost'}
              disabled={dueCount === 0 || busy === 'bulk'}
              onClick={() => void runAllDue()}
              title={dueCount === 0 ? 'Nothing due right now' : `Run ${dueCount} due recurrence(s)`}
            >
              {busy === 'bulk' ? 'Running…' : `Run all due (${dueCount})`}
            </Button>
            <Button
              size="sm"
              variant={showAdd ? 'ghost' : 'secondary'}
              onClick={() => setShowAdd((v) => !v)}
            >
              {showAdd ? 'Cancel' : '+ Add recurrence'}
            </Button>
          </div>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        {bulkResult && (
          <div
            style={{
              background: tokens.color.surface,
              padding: 8,
              borderRadius: tokens.radius.sm,
              fontSize: 12,
              marginBottom: 8,
            }}
          >
            <strong>Bulk run complete.</strong>{' '}
            {Object.entries(bulkResult.summary)
              .map(([k, v]) => `${v} ${k}`)
              .join(' · ')}
          </div>
        )}
        {showAdd && (
          <div
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              padding: 12,
              marginBottom: 8,
              display: 'grid',
              gap: 10,
              background: tokens.color.surface,
            }}
          >
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Template</label>
              <select
                value={addTemplateId}
                onChange={(e) => setAddTemplateId(e.target.value)}
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.bg,
                  color: tokens.color.text,
                }}
              >
                <option value="">Select…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <RecurrenceComposer
              value={addDraft}
              onChange={setAddDraft}
              showSeedFields={!lastEngagementId}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="sm"
                disabled={busy === 'add' || !addTemplateId}
                onClick={() => void addRecurrence()}
              >
                {busy === 'add' ? 'Saving…' : 'Add recurrence'}
              </Button>
            </div>
          </div>
        )}
        {editingId && editDraft && (
          <div
            style={{
              border: `1px solid ${tokens.color.accent}`,
              borderRadius: tokens.radius.sm,
              padding: 12,
              marginBottom: 8,
              display: 'grid',
              gap: 10,
              background: tokens.color.surface,
            }}
          >
            <strong style={{ fontSize: 13 }}>Edit recurrence</strong>
            <RecurrenceComposer value={editDraft} onChange={setEditDraft} showSeedFields={false} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" disabled={busy === editingId} onClick={() => void saveEdit()}>
                {busy === editingId ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === editingId}
                onClick={() => {
                  setEditingId(null);
                  setEditDraft(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {rows == null ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No recurring engagements on this client. Click <strong>+ Add recurrence</strong> to
            schedule one (annual tax engagement, monthly bookkeeping, etc.), or enable the
            <em> Make this engagement recurring </em>checkbox on the engagement create form.
          </p>
        ) : (
          <Table<RecurrenceRow>
            columns={[
              { key: 'tpl', header: 'Template', render: (r) => r.templateName },
              {
                key: 'freq',
                header: 'Frequency',
                render: (r) => (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Pill>
                      {r.frequency} · {r.triggerMode === 'SCHEDULE' ? 'sched' : 'on close'}
                    </Pill>
                    {(r.rollforwardAppointment || r.rollforwardDropoff) && (
                      <Pill tone="accent">
                        ↻{' '}
                        {[
                          r.rollforwardAppointment ? 'appt' : null,
                          r.rollforwardDropoff ? 'drop-off' : null,
                        ]
                          .filter(Boolean)
                          .join(' + ')}
                      </Pill>
                    )}
                  </span>
                ),
              },
              {
                key: 'next',
                header: 'Next run',
                render: (r) => r.nextRunDate ?? '—',
              },
              {
                key: 'last',
                header: 'Last engagement',
                render: (r) =>
                  r.lastEngagementName ? (
                    <a
                      href={`/engagements/${r.lastEngagementId}`}
                      style={{ color: tokens.color.accent, fontSize: 12 }}
                    >
                      {r.lastEngagementName}{' '}
                      <span style={{ color: tokens.color.textMuted }}>
                        ({r.lastEngagementStatus})
                      </span>
                    </a>
                  ) : (
                    <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>none yet</span>
                  ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (r) => (
                  <Pill
                    tone={
                      r.status === 'ACTIVE'
                        ? r.isDue
                          ? 'warning'
                          : 'success'
                        : r.status === 'PAUSED'
                          ? 'accent'
                          : 'neutral'
                    }
                  >
                    {r.isDue ? 'DUE' : r.status}
                  </Pill>
                ),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (r) => (
                  <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={r.status === 'CANCELLED' || busy === r.id}
                      onClick={() => startEdit(r)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant={r.isDue ? 'secondary' : 'ghost'}
                      disabled={r.status !== 'ACTIVE' || busy === r.id}
                      onClick={() => void runOne(r.id)}
                    >
                      {busy === r.id ? '…' : 'Run now'}
                    </Button>
                  </span>
                ),
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            empty=""
          />
        )}
      </Card>
    </>
  );
}
