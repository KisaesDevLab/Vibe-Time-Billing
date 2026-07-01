/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: Elastic-2.0
//
// Engagement "Drop-off" card. Staff set a due date by which the client
// must drop off / upload information; the client is reminded once
// (email + SMS) N days before the date and uploads through the portal
// to fulfill it.
//
// A drop-off is a specialized client_request (kind = 'DROP_OFF'), so it
// reuses the existing requests API, portal upload-to-fulfill flow, and
// reminder plumbing. Backed by /api/staff/requests with
// ?engagementId=<id>&kind=DROP_OFF for the list and POST for create.

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import {
  ReminderScheduleEditor,
  humanizeOffset,
  type ReminderStep,
} from '../../components/ReminderScheduleEditor';

// Preserves the old "email + SMS 3 days before" behavior as the starting point.
const DEFAULT_DROPOFF_REMINDERS: ReminderStep[] = [
  { offsetMinutes: 4320, channel: 'EMAIL' },
  { offsetMinutes: 4320, channel: 'SMS' },
];

interface DropOffRow {
  id: string;
  title: string;
  status: string;
  kind: string;
  dueDate: string | null;
  reminderDaysBefore: number | null;
  reminderSchedule: ReminderStep[] | null;
  lastReminderSentAt: string | null;
  createdAt: string;
}

function statusTone(s: string): 'success' | 'warning' | 'neutral' | 'accent' {
  switch (s) {
    case 'OPEN':
      return 'warning';
    case 'FULFILLED':
      return 'success';
    case 'NEEDS_INFO':
      return 'accent';
    default:
      return 'neutral';
  }
}

function inputStyle(): CSSProperties {
  return {
    padding: '6px 8px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.surface,
    color: tokens.color.text,
  };
}

export function DropOffCard({ engagementId }: { engagementId: string }): JSX.Element {
  const navigate = useNavigate();
  const [rows, setRows] = useState<DropOffRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  // Composer state.
  const [title, setTitle] = useState('Document drop-off');
  const [dueDate, setDueDate] = useState('');
  const [reminderSchedule, setReminderSchedule] =
    useState<ReminderStep[]>(DEFAULT_DROPOFF_REMINDERS);
  const [docList, setDocList] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({
        engagementId,
        kind: 'DROP_OFF',
        sort: 'due_date',
        dir: 'asc',
        limit: '100',
      });
      const r = await api<{ items: DropOffRow[]; total: number }>(
        `/api/staff/requests?${qs.toString()}`,
      );
      setRows(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setRows([]);
    }
  }, [engagementId]);

  useEffect(() => {
    void load();
  }, [load]);

  function resetComposer(): void {
    setTitle('Document drop-off');
    setDueDate('');
    setReminderSchedule(DEFAULT_DROPOFF_REMINDERS);
    setDocList('');
    setComposing(false);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (!dueDate) {
      setError('A due date is required for a drop-off.');
      return;
    }
    if (reminderSchedule.length === 0) {
      setError('Add at least one reminder (or the client is never nudged).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const items = docList
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((label, idx) => ({
          ordinal: idx,
          label,
          itemKind: 'DOCUMENT' as const,
          required: true,
        }));
      const body: Record<string, unknown> = {
        engagementId,
        kind: 'DROP_OFF',
        title: title.trim() || 'Document drop-off',
        dueDate,
        reminderSchedule,
      };
      if (items.length > 0) body['items'] = items;
      await api('/api/staff/requests', { method: 'POST', body: JSON.stringify(body) });
      resetComposer();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create_failed');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string): Promise<void> {
    try {
      await api(`/api/staff/requests/${id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Drop-off cancelled' }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'cancel_failed');
    }
  }

  return (
    <Card
      title="Drop-offs"
      action={
        !composing ? (
          <Button size="sm" variant="secondary" onClick={() => setComposing(true)}>
            Add drop-off
          </Button>
        ) : undefined
      }
    >
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Ask the client to drop off / upload information by a due date. The client is reminded once
        (email + SMS) the configured number of days before, and uploads through the portal to
        fulfill it.
      </p>

      {error && (
        <p style={{ fontSize: 12, color: tokens.color.danger }} role="alert">
          {error}
        </p>
      )}

      {composing && (
        <form
          onSubmit={(e) => void submit(e)}
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            padding: 12,
            marginBottom: 10,
            background: tokens.color.surface,
            display: 'grid',
            gap: 10,
          }}
        >
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={inputStyle()}
              maxLength={200}
            />
          </div>
          <div style={{ display: 'grid', gap: 4, maxWidth: 280 }}>
            <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Due date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              style={inputStyle()}
              required
            />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
              Reminders (before the due date)
            </label>
            <ReminderScheduleEditor
              value={reminderSchedule}
              onChange={setReminderSchedule}
              channels={['EMAIL', 'SMS']}
              helpText="the client won't be reminded"
            />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
              Documents to collect (optional — one per line)
            </label>
            <textarea
              value={docList}
              onChange={(e) => setDocList(e.target.value)}
              rows={3}
              placeholder={'W-2\n1099-INT\nMortgage interest statement'}
              style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create drop-off'}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={resetComposer} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {rows === null ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : (
        <Table<DropOffRow>
          rows={rows}
          rowKey={(r) => r.id}
          empty="No drop-offs yet."
          columns={[
            {
              key: 'title',
              header: 'Drop-off',
              render: (r) => (
                <button
                  type="button"
                  onClick={() => navigate(`/requests/${r.id}`)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: tokens.color.accent,
                    cursor: 'pointer',
                    fontSize: 13,
                    textAlign: 'left',
                  }}
                >
                  {r.title}
                </button>
              ),
            },
            {
              key: 'dueDate',
              header: 'Due',
              render: (r) => <span style={{ fontSize: 13 }}>{r.dueDate ?? '—'}</span>,
            },
            {
              key: 'reminder',
              header: 'Reminder',
              render: (r) => {
                const sched = r.reminderSchedule;
                if (sched && sched.length > 0) {
                  const summary =
                    sched.length === 1
                      ? `${humanizeOffset(sched[0]!.offsetMinutes)} · ${sched[0]!.channel}`
                      : `${sched.length} reminders`;
                  return (
                    <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{summary}</span>
                  );
                }
                return r.reminderDaysBefore === null ? (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>none</span>
                ) : (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {r.reminderDaysBefore}d before
                    {r.lastReminderSentAt ? ' · sent' : ''}
                  </span>
                );
              },
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
            },
            {
              key: 'actions',
              header: '',
              render: (r) =>
                r.status === 'OPEN' || r.status === 'NEEDS_INFO' ? (
                  <Button size="sm" variant="ghost" onClick={() => void cancel(r.id)}>
                    Cancel
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
    </Card>
  );
}
