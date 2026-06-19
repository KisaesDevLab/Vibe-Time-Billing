// SPDX-License-Identifier: Elastic-2.0
//
// Tax-season rollforward wizard (4 steps): scope → engagements → appointments →
// commit. Generates next-year engagements (the spine), rolls their drop-off
// dates, and proposes the dependent appointments, all reviewable then committed
// together. Backs onto /api/staff/rollforward.

import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';

interface EngCandidate {
  id: string;
  clientName: string;
  returnType: string | null;
  sourceDueDate: string | null;
  suggestedDueDate: string | null;
  sourceDropoffDate: string | null;
  suggestedDropoffDate: string | null;
  sourceFeeCents: number | null;
  suggestedFeeCents: number | null;
  status: 'PENDING' | 'APPROVED' | 'SKIPPED' | 'COMMITTED';
}
interface ApptCandidate {
  id: string;
  title: string;
  sourceStartsAt: string | null;
  suggestedStartsAt: string | null;
  durationMinutes: number;
  conflict: boolean;
  status: 'PENDING' | 'APPROVED' | 'SKIPPED' | 'COMMITTED';
}

const money = (c: number | null): string => (c == null ? '—' : `$${(c / 100).toLocaleString()}`);
const dateOnly = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');
// datetime-local value (local wall clock) from a UTC ISO string.
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fmtDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function RollforwardPage(): JSX.Element {
  const { me } = useAuth();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1
  const [staffId, setStaffId] = useState(me?.appUserId ?? '');
  const [staff, setStaff] = useState<{ id: string; fullName: string }[]>([]);
  const [sourceStart, setSourceStart] = useState('');
  const [sourceEnd, setSourceEnd] = useState('');
  const [targetYear, setTargetYear] = useState(new Date().getFullYear() + 1);
  const [mode, setMode] = useState<'DEADLINE' | 'ISO_WEEK'>('DEADLINE');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [allowApptOnly, setAllowApptOnly] = useState(false);

  // Batch
  const [batchId, setBatchId] = useState<string | null>(null);
  const [engs, setEngs] = useState<EngCandidate[]>([]);
  const [appts, setAppts] = useState<ApptCandidate[]>([]);
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [committed, setCommitted] = useState<{
    engagementsCreated: number;
    appointmentsCreated: number;
  } | null>(null);

  // Load the staff list once.
  useEffect(() => {
    void api<{ users: { id: string; fullName: string }[] }>('/api/staff/admin/users')
      .then((r) => setStaff(r.users ?? []))
      .catch(() => undefined);
  }, []);

  const conflictCount = appts.filter((a) => a.conflict && a.status !== 'SKIPPED').length;

  async function generate(): Promise<void> {
    if (!staffId || !sourceStart || !sourceEnd) {
      setError('Pick a staff person and a source date range.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ batchId: string; engagementCandidates: EngCandidate[] }>(
        '/api/staff/rollforward',
        {
          method: 'POST',
          body: JSON.stringify({
            staffId,
            sourceStart,
            sourceEnd,
            targetYear,
            mode,
            includeInactive,
          }),
        },
      );
      setBatchId(r.batchId);
      setEngs(r.engagementCandidates ?? []);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function patchEng(id: string, patch: Partial<EngCandidate>): Promise<void> {
    setEngs((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    await api(`/api/staff/rollforward/${batchId}/engagements/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).catch(() => undefined);
  }

  async function bulkEng(ids: string[], action: 'APPROVE' | 'UNAPPROVE' | 'SKIP'): Promise<void> {
    if (ids.length === 0) return;
    const status = action === 'APPROVE' ? 'APPROVED' : action === 'SKIP' ? 'SKIPPED' : 'PENDING';
    setEngs((prev) => prev.map((e) => (ids.includes(e.id) ? { ...e, status } : e)));
    await api(`/api/staff/rollforward/${batchId}/engagements/bulk`, {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    }).catch(() => undefined);
  }

  async function toAppointments(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ appointmentCandidates: ApptCandidate[] }>(
        `/api/staff/rollforward/${batchId}/appointments/preview`,
        { method: 'POST', body: JSON.stringify({ allowAppointmentOnly: allowApptOnly }) },
      );
      setAppts(r.appointmentCandidates ?? []);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function patchAppt(id: string, localValue: string): Promise<void> {
    const iso = new Date(localValue).toISOString();
    setAppts((prev) => prev.map((a) => (a.id === id ? { ...a, suggestedStartsAt: iso } : a)));
    const r = await api<{ appointmentCandidates: ApptCandidate[] }>(
      `/api/staff/rollforward/${batchId}/appointments/${id}`,
      { method: 'PATCH', body: JSON.stringify({ suggestedStartsAt: iso }) },
    ).catch(() => null);
    if (r) setAppts(r.appointmentCandidates ?? []);
  }

  async function bulkAppt(ids: string[], action: 'APPROVE' | 'UNAPPROVE' | 'SKIP'): Promise<void> {
    if (ids.length === 0) return;
    const status = action === 'APPROVE' ? 'APPROVED' : action === 'SKIP' ? 'SKIPPED' : 'PENDING';
    setAppts((prev) => prev.map((a) => (ids.includes(a.id) ? { ...a, status } : a)));
    await api(`/api/staff/rollforward/${batchId}/appointments/bulk`, {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    }).catch(() => undefined);
  }

  async function commit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ engagementsCreated: number; appointmentsCreated: number }>(
        `/api/staff/rollforward/${batchId}/commit`,
        { method: 'POST', body: JSON.stringify({ allowAppointmentOnly: allowApptOnly }) },
      );
      setCommitted(r);
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const approvedEngs = engs.filter((e) => e.status === 'APPROVED').length;
  const approvedAppts = appts.filter((a) => a.status === 'APPROVED').length;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Tax-season rollforward</h1>
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Step {step} of 4 · {['Scope', 'Engagements', 'Appointments', 'Done'][step - 1]}
        </span>
      </div>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 13 }} role="alert">
          {error}
        </p>
      )}

      {step === 1 && (
        <Card title="1 · Scope">
          <div style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              Staff person
              <select
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                style={fieldStyle}
              >
                <option value="">Select…</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ display: 'flex', gap: 12 }}>
              <Input
                label="Source start"
                type="date"
                value={sourceStart}
                onChange={(e) => setSourceStart(e.target.value)}
              />
              <Input
                label="Source end"
                type="date"
                value={sourceEnd}
                onChange={(e) => setSourceEnd(e.target.value)}
              />
              <Input
                label="Target year"
                type="number"
                value={String(targetYear)}
                onChange={(e) => setTargetYear(Number(e.target.value))}
              />
            </div>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              Date mapping
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'DEADLINE' | 'ISO_WEEK')}
                style={fieldStyle}
              >
                <option value="DEADLINE">Deadline-anchored (keep distance from 3/15 · 4/15)</option>
                <option value="ISO_WEEK">ISO-week-anchored (same week number)</option>
              </select>
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                Deadline-anchored keeps each item the same number of weeks from its filing deadline,
                on the same weekday. ISO-week keeps the same calendar week number.
              </span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
              />
              Include engagements for inactive / archived clients
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={allowApptOnly}
                onChange={(e) => setAllowApptOnly(e.target.checked)}
              />
              Also roll appointments whose engagement isn&apos;t kept (e.g. consults)
            </label>
            <div>
              <Button onClick={() => void generate()} disabled={busy}>
                {busy ? 'Generating…' : 'Generate engagements →'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card
          title={`2 · Engagements (${engs.length})`}
          action={
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void bulkEng(
                    engs.map((e) => e.id),
                    'APPROVE',
                  )
                }
              >
                Approve all
              </Button>
            </span>
          }
        >
          {engs.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              No engagements for that staff person in the source window.
            </p>
          ) : (
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: tokens.color.textMuted }}>
                  <th style={th}>Client</th>
                  <th style={th}>Type</th>
                  <th style={th}>Prior drop-off</th>
                  <th style={th}>Suggested drop-off</th>
                  <th style={th}>Prior fee</th>
                  <th style={th}>Suggested fee</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {engs.map((e) => (
                  <tr key={e.id} style={{ opacity: e.status === 'SKIPPED' ? 0.5 : 1 }}>
                    <td style={td}>{e.clientName}</td>
                    <td style={td}>{e.returnType ?? '—'}</td>
                    <td style={td}>{dateOnly(e.sourceDropoffDate) || '—'}</td>
                    <td style={td}>
                      <input
                        type="date"
                        value={dateOnly(e.suggestedDropoffDate)}
                        onChange={(ev) =>
                          void patchEng(e.id, { suggestedDropoffDate: ev.target.value })
                        }
                        style={cellInput}
                      />
                    </td>
                    <td style={td}>{money(e.sourceFeeCents)}</td>
                    <td style={td}>
                      <input
                        type="number"
                        value={e.suggestedFeeCents == null ? '' : String(e.suggestedFeeCents / 100)}
                        onChange={(ev) =>
                          void patchEng(e.id, {
                            suggestedFeeCents: Math.round(Number(ev.target.value) * 100),
                          })
                        }
                        style={{ ...cellInput, width: 90 }}
                      />
                    </td>
                    <td style={td}>
                      <StatusCell
                        status={e.status}
                        onApprove={() => void bulkEng([e.id], 'APPROVE')}
                        onSkip={() => void bulkEng([e.id], 'SKIP')}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button onClick={() => void toAppointments()} disabled={busy}>
              {busy ? '…' : 'Next: appointments →'}
            </Button>
            <span style={{ fontSize: 12, color: tokens.color.textMuted, alignSelf: 'center' }}>
              {approvedEngs} approved · skipping an engagement also drops its appointment.
            </span>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card
          title={`3 · Appointments (${appts.length})`}
          action={
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              {conflictCount > 0 && <Pill tone="danger">{conflictCount} conflict</Pill>}
              <label style={{ fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={onlyConflicts}
                  onChange={(e) => setOnlyConflicts(e.target.checked)}
                />
                Only conflicts
              </label>
            </span>
          }
        >
          {appts.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              No appointments tied to the approved engagements.
            </p>
          ) : (
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: tokens.color.textMuted }}>
                  <th style={th}>Appointment</th>
                  <th style={th}>Original</th>
                  <th style={th}>Suggested</th>
                  <th style={th}>Min</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {appts
                  .filter((a) => !onlyConflicts || a.conflict)
                  .map((a) => (
                    <tr
                      key={a.id}
                      style={{
                        background: a.conflict ? 'rgba(220,38,38,0.12)' : undefined,
                        opacity: a.status === 'SKIPPED' ? 0.5 : 1,
                      }}
                    >
                      <td style={td}>
                        {a.title} {a.conflict && <Pill tone="danger">conflict</Pill>}
                      </td>
                      <td style={td}>{fmtDateTime(a.sourceStartsAt)}</td>
                      <td style={td}>
                        <input
                          type="datetime-local"
                          value={toLocalInput(a.suggestedStartsAt)}
                          onChange={(ev) => void patchAppt(a.id, ev.target.value)}
                          style={{ ...cellInput, width: 190 }}
                        />
                      </td>
                      <td style={td}>{a.durationMinutes}</td>
                      <td style={td}>
                        <StatusCell
                          status={a.status}
                          onApprove={() => void bulkAppt([a.id], 'APPROVE')}
                          onSkip={() => void bulkAppt([a.id], 'SKIP')}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button variant="secondary" onClick={() => setStep(2)}>
              ← Back
            </Button>
            <Button onClick={() => void commit()} disabled={busy}>
              {busy
                ? 'Committing…'
                : `Commit (${approvedEngs} engagements, ${approvedAppts} appts) →`}
            </Button>
          </div>
        </Card>
      )}

      {step === 4 && committed && (
        <Card title="4 · Done">
          <p style={{ fontSize: 14 }}>
            Created <strong>{committed.engagementsCreated}</strong> engagements and{' '}
            <strong>{committed.appointmentsCreated}</strong> appointments for {targetYear}. The new
            engagements are <strong>drafts</strong> — review and activate them as usual.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setStep(1);
              setBatchId(null);
              setEngs([]);
              setAppts([]);
              setCommitted(null);
            }}
          >
            Start another
          </Button>
        </Card>
      )}
    </div>
  );
}

function StatusCell({
  status,
  onApprove,
  onSkip,
}: {
  status: string;
  onApprove: () => void;
  onSkip: () => void;
}): JSX.Element {
  if (status === 'APPROVED') return <Pill tone="success">approved</Pill>;
  if (status === 'SKIPPED') return <Pill tone="neutral">skipped</Pill>;
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <Button size="sm" variant="secondary" onClick={onApprove}>
        Approve
      </Button>
      <Button size="sm" variant="ghost" onClick={onSkip}>
        Skip
      </Button>
    </span>
  );
}

const fieldStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 13,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.text,
};
const th: React.CSSProperties = {
  padding: '6px 8px',
  fontWeight: 600,
  borderBottom: `1px solid ${tokens.color.border}`,
};
const td: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: `1px solid ${tokens.color.border}`,
};
const cellInput: React.CSSProperties = {
  padding: '4px 6px',
  fontSize: 12,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.bg,
  color: tokens.color.text,
};
