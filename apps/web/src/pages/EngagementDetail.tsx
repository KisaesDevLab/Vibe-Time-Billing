// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button, Card, Combobox, Pill, Table, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';
import { centsToDollarsInput, dollarsInputToCents } from '../lib/money';

const FEE_STRUCTURES = [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_WITH_MILESTONES',
  'RECURRING_SUBSCRIPTION',
] as const;
type FeeStructure = (typeof FEE_STRUCTURES)[number];

const STATUSES = ['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'] as const;
type EngagementStatusKind = (typeof STATUSES)[number];

const editFieldStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

interface Engagement {
  id: string;
  clientId: string;
  name: string;
  status: string;
  feeStructure: string;
  feeAmountCents: number | null;
  budgetHours: string | null;
  budgetAmountCents: number | null;
  mixedModeEnabled: boolean;
  inScopeWorkCodeIds: string[];
  nteCapCents: number | null;
  feePassthroughEnabled: boolean;
  partnerId: string | null;
  managerId: string | null;
  startDate: string | null;
  endDate: string | null;
}

interface Summary {
  engagementId: string;
  timeEntries: {
    total: number;
    totalHours: number;
    totalAmountCents: number;
    submittedCount: number;
    billedCount: number;
  };
  invoicing: {
    invoicedCents: number;
    paidCents: number;
    openCount: number;
  };
}

interface Milestone {
  id: string;
  name: string;
  sequence: number;
  amountCents: number;
  status: string;
  triggerType: string;
  triggerDate: string | null;
}

interface HourBank {
  id: string;
  openingHours: string;
  openingAmountCents: number;
  expirationDate: string | null;
  forfeitedAt: string | null;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// QA fix — draft fields now hold dollars representation; renamed
// from *Cents to *Dollars so it's obvious. Translation happens in
// emptyDraftFrom (cents → dollars) and the save handler (dollars →
// cents).
interface EditDraft {
  name: string;
  feeStructure: FeeStructure;
  feeAmountDollars: string;
  budgetHours: string;
  budgetAmountDollars: string;
  nteCapDollars: string;
  startDate: string;
  endDate: string;
  mixedModeEnabled: boolean;
  feePassthroughEnabled: boolean;
}

function emptyDraftFrom(e: Engagement): EditDraft {
  return {
    name: e.name,
    feeStructure: e.feeStructure as FeeStructure,
    feeAmountDollars: centsToDollarsInput(e.feeAmountCents),
    budgetHours: e.budgetHours ?? '',
    budgetAmountDollars: centsToDollarsInput(e.budgetAmountCents),
    nteCapDollars: centsToDollarsInput(e.nteCapCents),
    startDate: e.startDate ?? '',
    endDate: e.endDate ?? '',
    mixedModeEnabled: e.mixedModeEnabled,
    feePassthroughEnabled: e.feePassthroughEnabled,
  };
}

export function EngagementDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [banks, setBanks] = useState<HourBank[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);

  async function reload(): Promise<void> {
    if (!id) return;
    try {
      const [e, s, m, b] = await Promise.all([
        api<{ engagement: Engagement }>(`/api/staff/engagements/${id}`),
        api<{ summary: Summary | null }>(`/api/staff/stats/engagement/${id}`),
        api<{ milestones: Milestone[] }>(`/api/staff/milestones/by-engagement/${id}`),
        api<{ bank: HourBank | null }>(`/api/staff/hour-banks/by-engagement/${id}`).catch(() => ({
          bank: null,
        })),
      ]);
      setEngagement(e.engagement);
      setSummary(s.summary);
      setMilestones(m.milestones ?? []);
      setBanks(b.bank ? [b.bank] : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function saveEdit(): Promise<void> {
    if (!id || !draft) return;
    setSavingEdit(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        feeStructure: draft.feeStructure,
        mixedModeEnabled: draft.mixedModeEnabled,
        feePassthroughEnabled: draft.feePassthroughEnabled,
      };
      const feeCents = dollarsInputToCents(draft.feeAmountDollars);
      if (feeCents != null) body.feeAmountCents = feeCents;
      if (draft.budgetHours.trim()) body.budgetHours = Number(draft.budgetHours);
      const budgetCents = dollarsInputToCents(draft.budgetAmountDollars);
      if (budgetCents != null) body.budgetAmountCents = budgetCents;
      const nteCents = dollarsInputToCents(draft.nteCapDollars);
      if (nteCents != null) body.nteCapCents = nteCents;
      if (draft.startDate) body.startDate = draft.startDate;
      if (draft.endDate) body.endDate = draft.endDate;
      await api(`/api/staff/engagements/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setEditing(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setSavingEdit(false);
    }
  }

  async function changeStatus(next: EngagementStatusKind): Promise<void> {
    if (!id) return;
    if (next === 'CLOSED' || next === 'ARCHIVED') {
      if (!confirm(`Move engagement to ${next}? This may be hard to reverse.`)) return;
    }
    setSavingStatus(true);
    setError(null);
    try {
      await api(`/api/staff/engagements/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'status_failed');
    } finally {
      setSavingStatus(false);
    }
  }

  if (error) {
    return (
      <Card title="Error">
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }
  if (!engagement) {
    return (
      <Card title="Engagement">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
          {error}
        </p>
      )}
      <Card
        title={
          editing && draft ? (
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              style={{ ...editFieldStyle, fontSize: 16, fontWeight: 600, minWidth: 280 }}
              aria-label="Engagement name"
            />
          ) : (
            engagement.name
          )
        }
        action={
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ width: 160 }}>
              <Combobox
                ariaLabel="Engagement status"
                value={engagement.status}
                onChange={(v) => void changeStatus(v as EngagementStatusKind)}
                disabled={savingStatus || editing}
                options={STATUSES.map<ComboboxOption>((s) => ({ value: s, label: s }))}
                size="sm"
              />
            </div>
            <Pill tone="accent">{engagement.feeStructure}</Pill>
            {editing ? (
              <>
                <Button size="sm" onClick={() => void saveEdit()} disabled={savingEdit}>
                  {savingEdit ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft(null);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDraft(emptyDraftFrom(engagement));
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
          </span>
        }
      >
        {editing && draft ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Fee structure">
              <Combobox
                ariaLabel="Fee structure"
                value={draft.feeStructure}
                onChange={(v) => setDraft({ ...draft, feeStructure: v as FeeStructure })}
                options={FEE_STRUCTURES.map<ComboboxOption>((s) => ({ value: s, label: s }))}
              />
            </Field>
            <Field label="Fee amount ($)">
              <input
                type="text"
                inputMode="decimal"
                value={draft.feeAmountDollars}
                onChange={(e) => setDraft({ ...draft, feeAmountDollars: e.target.value })}
                placeholder="0.00"
                style={editFieldStyle}
              />
            </Field>
            <Field label="Budget hours">
              <input
                type="number"
                min={0}
                step={0.25}
                value={draft.budgetHours}
                onChange={(e) => setDraft({ ...draft, budgetHours: e.target.value })}
                style={editFieldStyle}
              />
            </Field>
            <Field label="Budget ($)">
              <input
                type="text"
                inputMode="decimal"
                value={draft.budgetAmountDollars}
                onChange={(e) => setDraft({ ...draft, budgetAmountDollars: e.target.value })}
                placeholder="0.00"
                style={editFieldStyle}
              />
            </Field>
            <Field label="NTE cap ($)">
              <input
                type="text"
                inputMode="decimal"
                value={draft.nteCapDollars}
                onChange={(e) => setDraft({ ...draft, nteCapDollars: e.target.value })}
                placeholder="0.00"
                style={editFieldStyle}
              />
            </Field>
            <Field label="Start date">
              <input
                type="date"
                value={draft.startDate}
                onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
                style={editFieldStyle}
              />
            </Field>
            <Field label="End date">
              <input
                type="date"
                value={draft.endDate}
                onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
                style={editFieldStyle}
              />
            </Field>
            <Field label="Mixed mode">
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={draft.mixedModeEnabled}
                  onChange={(e) => setDraft({ ...draft, mixedModeEnabled: e.target.checked })}
                />
                Enable in-scope tagging per entry
              </label>
            </Field>
            <Field label="Fee passthrough">
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={draft.feePassthroughEnabled}
                  onChange={(e) => setDraft({ ...draft, feePassthroughEnabled: e.target.checked })}
                />
                Add processing fee line item on invoices
              </label>
            </Field>
          </div>
        ) : (
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto 1fr',
              gap: '6px 16px',
              fontSize: 13,
              margin: 0,
            }}
          >
            <dt style={{ color: tokens.color.textMuted }}>Client</dt>
            <dd style={{ margin: 0 }}>
              <a href={`/clients/${engagement.clientId}`}>open</a>
            </dd>
            <dt style={{ color: tokens.color.textMuted }}>Fee</dt>
            <dd style={{ margin: 0 }}>
              {engagement.feeAmountCents == null ? '—' : formatCents(engagement.feeAmountCents)}
            </dd>
            <dt style={{ color: tokens.color.textMuted }}>Budget hours</dt>
            <dd style={{ margin: 0 }}>{engagement.budgetHours ?? '—'}</dd>
            <dt style={{ color: tokens.color.textMuted }}>Budget $</dt>
            <dd style={{ margin: 0 }}>
              {engagement.budgetAmountCents == null
                ? '—'
                : formatCents(engagement.budgetAmountCents)}
            </dd>
            <dt style={{ color: tokens.color.textMuted }}>NTE cap</dt>
            <dd style={{ margin: 0 }}>
              {engagement.nteCapCents == null ? '—' : formatCents(engagement.nteCapCents)}
            </dd>
            <dt style={{ color: tokens.color.textMuted }}>Mixed mode</dt>
            <dd style={{ margin: 0 }}>{engagement.mixedModeEnabled ? 'yes' : 'no'}</dd>
            <dt style={{ color: tokens.color.textMuted }}>Fee passthrough</dt>
            <dd style={{ margin: 0 }}>{engagement.feePassthroughEnabled ? 'yes' : 'no'}</dd>
            <dt style={{ color: tokens.color.textMuted }}>Start</dt>
            <dd style={{ margin: 0 }}>{engagement.startDate ?? '—'}</dd>
            <dt style={{ color: tokens.color.textMuted }}>End</dt>
            <dd style={{ margin: 0 }}>{engagement.endDate ?? '—'}</dd>
          </dl>
        )}
      </Card>

      {summary && (
        <Card title="Activity">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: 16,
            }}
          >
            <Stat label="Time entries" value={summary.timeEntries.total.toLocaleString()} />
            <Stat label="Hours" value={summary.timeEntries.totalHours.toFixed(2)} />
            <Stat label="WIP" value={formatCents(summary.timeEntries.totalAmountCents)} />
            <Stat label="Invoiced" value={formatCents(summary.invoicing.invoicedCents)} />
            <Stat label="Paid" value={formatCents(summary.invoicing.paidCents)} />
          </div>
        </Card>
      )}

      <LetterGenerator
        engagementId={id ?? ''}
        engagement={engagement}
        onGenerated={() => void reload()}
      />

      {milestones.length > 0 && (
        <Card title={`Milestones (${milestones.length})`}>
          <Table<Milestone>
            columns={[
              { key: 'seq', header: '#', render: (m) => String(m.sequence) },
              { key: 'name', header: 'Name', render: (m) => m.name },
              {
                key: 'amt',
                header: 'Amount',
                align: 'right',
                render: (m) => formatCents(m.amountCents),
              },
              {
                key: 'trig',
                header: 'Trigger',
                render: (m) =>
                  m.triggerType === 'DATE' ? `DATE · ${m.triggerDate ?? ''}` : m.triggerType,
              },
              {
                key: 'status',
                header: 'Status',
                render: (m) => (
                  <Pill
                    tone={
                      m.status === 'INVOICED'
                        ? 'success'
                        : m.status === 'TRIGGERED'
                          ? 'accent'
                          : 'neutral'
                    }
                  >
                    {m.status}
                  </Pill>
                ),
              },
            ]}
            rows={milestones}
            rowKey={(m) => m.id}
            empty="—"
          />
        </Card>
      )}

      {banks.length > 0 && (
        <Card title={`Hour banks (${banks.length})`}>
          <Table<HourBank>
            columns={[
              {
                key: 'open-h',
                header: 'Opening hours',
                render: (b) => b.openingHours,
              },
              {
                key: 'open-a',
                header: 'Opening $',
                align: 'right',
                render: (b) => formatCents(b.openingAmountCents),
              },
              { key: 'exp', header: 'Expires', render: (b) => b.expirationDate ?? '—' },
              {
                key: 'status',
                header: 'Status',
                render: (b) =>
                  b.forfeitedAt ? (
                    <Pill tone="warning">FORFEITED</Pill>
                  ) : (
                    <Pill tone="success">ACTIVE</Pill>
                  ),
              },
            ]}
            rows={banks}
            rowKey={(b) => b.id}
            empty="—"
          />
        </Card>
      )}

      <EngagementNotes engagementId={id ?? ''} />
    </div>
  );
}

interface Note {
  id: string;
  authorId: string;
  body: string;
  pinned: boolean;
  createdAt: string;
}

function EngagementNotes({ engagementId }: { engagementId: string }): JSX.Element {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    if (!engagementId) return;
    try {
      const r = await api<{ items: Note[] }>(`/api/staff/engagements/${engagementId}/notes`);
      setNotes(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engagementId]);

  async function add(): Promise<void> {
    if (!body.trim()) return;
    try {
      await api(`/api/staff/engagements/${engagementId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body, pinned }),
      });
      setBody('');
      setPinned(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(noteId: string): Promise<void> {
    try {
      await api(`/api/staff/engagements/${engagementId}/notes/${noteId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <Card title={`Notes (${notes.length})`}>
      <div style={{ display: 'grid', gap: 12 }}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="Add a note…"
          style={{
            width: '100%',
            padding: 8,
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.color.border}`,
            background: tokens.color.surface,
            color: tokens.color.text,
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            Pin
          </label>
          <button
            type="button"
            onClick={() => void add()}
            style={{
              padding: '6px 12px',
              borderRadius: tokens.radius.sm,
              border: 'none',
              background: tokens.color.accent,
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Add
          </button>
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      </div>
      <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
        {notes.map((n) => (
          <div
            key={n.id}
            style={{
              padding: 12,
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.border}`,
              fontSize: 13,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 6,
                color: tokens.color.textMuted,
                fontSize: 11,
              }}
            >
              <span>{new Date(n.createdAt).toLocaleString()}</span>
              <span>
                {n.pinned && <Pill tone="accent">pinned</Pill>}{' '}
                <button
                  type="button"
                  onClick={() => void remove(n.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tokens.color.textMuted,
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                >
                  delete
                </button>
              </span>
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
          </div>
        ))}
        {notes.length === 0 && (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No notes yet.</p>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'block' }}>
      <span
        style={{ fontSize: 11, color: tokens.color.textMuted, display: 'block', marginBottom: 4 }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

// =====================================================================
// LetterGenerator — picks a letter template, substitutes {{handlebars}}
// vars from the engagement + client, saves as a DRAFT letter row.
// =====================================================================

interface LetterTemplate {
  id: string;
  name: string;
  bodyHtml: string;
  isSystem: boolean;
  status: string;
}

interface ClientLite {
  id: string;
  name: string;
}

function substituteVars(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, name: string) => {
    return vars[name] ?? `{{${name}}}`;
  });
}

function LetterGenerator({
  engagementId,
  engagement,
  onGenerated,
}: {
  engagementId: string;
  engagement: Engagement;
  onGenerated: () => void;
}): JSX.Element {
  const [templates, setTemplates] = useState<LetterTemplate[]>([]);
  const [pickedId, setPickedId] = useState('');
  const [preview, setPreview] = useState('');
  const [client, setClient] = useState<ClientLite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [t, c] = await Promise.all([
          api<{ items: LetterTemplate[] }>('/api/staff/admin/templates/letter'),
          api<{ client: ClientLite }>(`/api/staff/clients/${engagement.clientId}`).catch(() => ({
            client: { id: engagement.clientId, name: 'client' },
          })),
        ]);
        setTemplates((t.items ?? []).filter((x) => x.status === 'ACTIVE'));
        setClient(c.client);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'load_failed');
      }
    })();
  }, [engagement.clientId]);

  useEffect(() => {
    if (!pickedId) {
      setPreview('');
      return;
    }
    const tpl = templates.find((t) => t.id === pickedId);
    if (!tpl) return;
    const feeStr =
      engagement.feeAmountCents != null ? formatCents(engagement.feeAmountCents) : 'TBD';
    setPreview(
      substituteVars(tpl.bodyHtml, {
        'client.name': client?.name ?? '',
        'engagement.name': engagement.name,
        'engagement.fee': feeStr,
        'engagement.tax_year': new Date().getFullYear().toString(),
        'engagement.fye_date': engagement.endDate ?? 'TBD',
      }),
    );
  }, [pickedId, templates, engagement, client]);

  async function generate(): Promise<void> {
    if (!pickedId || !preview) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await api<{ id: string; version: number }>('/api/staff/engagement-letters', {
        method: 'POST',
        body: JSON.stringify({ engagementId, bodyHtml: preview }),
      });
      setStatus(`Letter v${r.version} created as DRAFT (id: ${r.id.slice(0, 8)}…).`);
      setPickedId('');
      setPreview('');
      onGenerated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'generate_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Engagement letter">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Generate a draft letter from a template. Variables (<code>{`{{client.name}}`}</code>,{' '}
        <code>{`{{engagement.name}}`}</code>, <code>{`{{engagement.fee}}`}</code>) substitute in the
        preview before save.
      </p>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
          {error}
        </p>
      )}
      {status && (
        <p style={{ color: tokens.color.success, fontSize: 12 }} role="status">
          {status}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Template
          </div>
          <Combobox
            ariaLabel="Letter template"
            value={pickedId}
            onChange={setPickedId}
            options={templates.map<ComboboxOption>((t) => ({
              value: t.id,
              label: t.name,
              description: t.isSystem ? 'system' : undefined,
            }))}
            placeholder="— pick —"
          />
        </div>
        <Button onClick={() => void generate()} disabled={busy || !pickedId}>
          {busy ? 'Saving…' : 'Save as draft'}
        </Button>
      </div>
      {preview && (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: tokens.color.bg,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            fontFamily: tokens.font.body,
            whiteSpace: 'pre-wrap',
            maxHeight: 280,
            overflow: 'auto',
          }}
        >
          {preview}
        </pre>
      )}
    </Card>
  );
}
