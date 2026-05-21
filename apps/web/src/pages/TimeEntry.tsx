// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  AiPanel,
  Button,
  Card,
  Combobox,
  Input,
  Pill,
  Table,
  tokens,
  type ComboboxOption,
} from '@vibe/ui';

import { api } from '../api-client';
import { aiUsable, useAiStatus } from '../hooks/useAiStatus';

interface Engagement {
  id: string;
  name: string;
  clientId: string;
  // v2 Sprint E — needed for client-first filtering. Server already
  // returns it on /engagements; older callers ignored it.
  status?: string;
}

interface Client {
  id: string;
  name: string;
  status?: string;
}

interface WorkCode {
  id: string;
  name: string;
}

interface TimeEntry {
  id: string;
  engagementId: string;
  workCodeId?: string | null;
  entryDate: string;
  hours: string;
  standardAmountCents: number;
  billableFlag: boolean;
  inScopeFlag: boolean;
  description: string;
}

interface DayTotal {
  entryDate: string;
  hours: number;
  amountCents: number;
}

interface MonthTotal {
  month: string;
  hours: number;
  amountCents: number;
  count: number;
}

type ViewMode = 'log' | 'day' | 'week' | 'month';

const today = (): string => new Date().toISOString().slice(0, 10);

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function startOfWeek(iso: string): string {
  // Monday-anchored week (matches Postgres date_trunc('week') ISO default).
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0..6, Sunday=0
  const delta = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
  });
}

export function TimeEntryPage(): JSX.Element {
  const [view, setView] = useState<ViewMode>('log');
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [pinnedClientIds, setPinnedClientIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      try {
        const [e, w, c, p] = await Promise.all([
          api<{ items: Engagement[] }>('/api/staff/engagements'),
          api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes'),
          api<{ items: Client[] }>('/api/staff/clients'),
          api<{ items: { clientId: string }[] }>('/api/staff/clients/pins').catch(() => ({
            items: [],
          })),
        ]);
        setEngagements(e.items ?? []);
        setWorkCodes(w.items ?? []);
        // Sort pinned clients to top of the list.
        const pins = new Set((p.items ?? []).map((x) => x.clientId));
        setPinnedClientIds(pins);
        const sorted = [...(c.items ?? [])].sort((a, b) => {
          const pa = pins.has(a.id) ? 0 : 1;
          const pb = pins.has(b.id) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return a.name.localeCompare(b.name);
        });
        setClients(sorted);
      } catch {
        // Silent; child views render empty/error states themselves.
      }
    })();
  }, []);

  async function togglePin(clientId: string): Promise<void> {
    const isPinned = pinnedClientIds.has(clientId);
    try {
      if (isPinned) {
        await api(`/api/staff/clients/pins/${clientId}`, { method: 'DELETE' });
        const next = new Set(pinnedClientIds);
        next.delete(clientId);
        setPinnedClientIds(next);
      } else {
        await api('/api/staff/clients/pins', {
          method: 'POST',
          body: JSON.stringify({ clientId }),
        });
        const next = new Set(pinnedClientIds);
        next.add(clientId);
        setPinnedClientIds(next);
      }
      // Re-sort with new pin state.
      setClients((prev) =>
        [...prev].sort((a, b) => {
          const set = isPinned
            ? new Set(Array.from(pinnedClientIds).filter((id) => id !== clientId))
            : new Set([...Array.from(pinnedClientIds), clientId]);
          const pa = set.has(a.id) ? 0 : 1;
          const pb = set.has(b.id) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return a.name.localeCompare(b.name);
        }),
      );
    } catch {
      // Non-fatal.
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <ViewTabs view={view} onChange={setView} />
      {view === 'log' && (
        <LogView
          engagements={engagements}
          workCodes={workCodes}
          clients={clients}
          pinnedClientIds={pinnedClientIds}
          onTogglePin={(id) => void togglePin(id)}
        />
      )}
      {view === 'day' && <DayView engagements={engagements} clients={clients} />}
      {view === 'week' && <WeekView engagements={engagements} clients={clients} />}
      {view === 'month' && <MonthView />}
    </div>
  );
}

// v2 Sprint E — last-used client persisted per timekeeper-day. Used by
// the Quick log combobox so a CPA's first time entry of the day starts
// where they left off the day before. Server-side preference comes in
// a later sprint; localStorage is the v1 of this.
const LAST_CLIENT_KEY = '__vibe_last_client_id';

function ViewTabs({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}): JSX.Element {
  const tabs: { id: ViewMode; label: string }[] = [
    { id: 'log', label: 'Quick log' },
    { id: 'day', label: 'Day' },
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
  ];
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        width: 'fit-content',
      }}
    >
      {tabs.map((t) => {
        const active = view === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            style={{
              padding: '6px 14px',
              border: 'none',
              borderRadius: tokens.radius.sm,
              background: active ? tokens.color.accent : 'transparent',
              color: active ? '#fff' : tokens.color.text,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function LogView({
  engagements,
  workCodes,
  clients,
  pinnedClientIds,
  onTogglePin,
}: {
  engagements: Engagement[];
  workCodes: WorkCode[];
  clients: Client[];
  pinnedClientIds: Set<string>;
  onTogglePin: (clientId: string) => void;
}): JSX.Element {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // v2 Sprint E — client-first workflow. The CPA picks a client, then
  // engagement is filtered to that client's ACTIVE engagements. If the
  // client has exactly one active engagement it auto-selects.
  const [clientId, setClientId] = useState(() => {
    try {
      return localStorage.getItem(LAST_CLIENT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [engagementId, setEngagementId] = useState('');
  const [workCodeId, setWorkCodeId] = useState('');
  const [entryDate, setEntryDate] = useState(today());
  const [hours, setHours] = useState('1.00');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Engagements for the picked client, ACTIVE only. ACTIVE filter is
  // resilient: many existing engagements were created with status
  // PROPOSED or no status at all — fall back to "include unless
  // explicitly ARCHIVED or CLOSED" to avoid empty dropdowns.
  const filteredEngagements = useMemo(() => {
    if (!clientId) return [];
    return engagements.filter(
      (e) =>
        e.clientId === clientId &&
        e.status !== 'ARCHIVED' &&
        e.status !== 'CLOSED' &&
        e.status !== 'CANCELED',
    );
  }, [clientId, engagements]);

  // Auto-select the engagement when the picked client has exactly one
  // active engagement. If they have more, clear so the user picks.
  useEffect(() => {
    if (filteredEngagements.length === 1) {
      setEngagementId(filteredEngagements[0]!.id);
    } else if (!filteredEngagements.some((e) => e.id === engagementId)) {
      // Current selection no longer belongs to this client.
      setEngagementId('');
    }
  }, [filteredEngagements, engagementId]);

  // Persist last-used client.
  useEffect(() => {
    if (clientId) {
      try {
        localStorage.setItem(LAST_CLIENT_KEY, clientId);
      } catch {
        // Storage might be disabled; non-fatal.
      }
    }
  }, [clientId]);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const t = await api<{ items: TimeEntry[] }>('/api/staff/time-entries/mine');
      setEntries(t.items ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!engagementId) {
      setError('Pick a client + engagement first.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api('/api/staff/time-entries', {
        method: 'POST',
        body: JSON.stringify({
          engagementId,
          workCodeId: workCodeId || undefined,
          entryDate,
          hours: Number(hours),
          description,
        }),
      });
      setHours('1.00');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setSubmitting(false);
    }
  }

  const totalHours = entries.reduce((s, e) => s + Number(e.hours), 0);
  const totalAmount = entries.reduce((s, e) => s + e.standardAmountCents, 0);

  const clientHasNoActive = clientId && filteredEngagements.length === 0;
  const activeClients = clients.filter((c) => c.status !== 'ARCHIVED');

  return (
    <>
      <Card title="Log time">
        <form
          onSubmit={submit}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 2fr 1fr 1fr',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 12,
                color: tokens.color.textMuted,
                marginBottom: 4,
                display: 'flex',
                gap: 6,
                alignItems: 'center',
              }}
            >
              Client
              {clientId && (
                <button
                  type="button"
                  onClick={() => onTogglePin(clientId)}
                  aria-label={pinnedClientIds.has(clientId) ? 'Unpin client' : 'Pin client'}
                  title={
                    pinnedClientIds.has(clientId)
                      ? 'Unpin (remove from top of list)'
                      : 'Pin (sort to top of list)'
                  }
                  style={{
                    fontSize: 12,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: pinnedClientIds.has(clientId)
                      ? tokens.color.accent
                      : tokens.color.textMuted,
                    padding: 0,
                  }}
                >
                  {pinnedClientIds.has(clientId) ? '★' : '☆'}
                </button>
              )}
            </div>
            <Combobox
              ariaLabel="Client"
              required
              value={clientId}
              onChange={(v) => {
                setClientId(v);
                setEngagementId('');
              }}
              options={activeClients.map<ComboboxOption>((c) => ({
                value: c.id,
                label: pinnedClientIds.has(c.id) ? `★ ${c.name}` : c.name,
              }))}
              placeholder="— select client —"
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
              Engagement
              {filteredEngagements.length === 1 && clientId && (
                <span style={{ color: tokens.color.accent, marginLeft: 6 }}>(auto-selected)</span>
              )}
            </div>
            <Combobox
              ariaLabel="Engagement"
              required
              disabled={!clientId || filteredEngagements.length === 0}
              value={engagementId}
              onChange={setEngagementId}
              options={filteredEngagements.map<ComboboxOption>((e) => ({
                value: e.id,
                label: e.name,
              }))}
              placeholder={
                !clientId
                  ? '— pick client first —'
                  : filteredEngagements.length === 0
                    ? '— no active engagements —'
                    : '— select —'
              }
            />
          </div>
          <Input
            type="date"
            label="Date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
          />
          <Input
            type="number"
            step={0.25}
            min={0.25}
            max={24}
            label="Hours"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <div style={{ gridColumn: 'span 3', display: 'grid', gap: 6 }}>
            <div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Work code
              </div>
              <Combobox
                ariaLabel="Work code"
                clearable
                value={workCodeId}
                onChange={setWorkCodeId}
                options={workCodes.map<ComboboxOption>((w) => ({ value: w.id, label: w.name }))}
                placeholder="— none —"
              />
            </div>
            <Input
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What you worked on"
            />
            <AiDescribeButton
              engagementName={engagements.find((e) => e.id === engagementId)?.name}
              workCodeName={workCodes.find((w) => w.id === workCodeId)?.name}
              hours={hours ? parseFloat(hours) : undefined}
              onPick={(s) => setDescription(s)}
            />
          </div>
          <Button type="submit" disabled={submitting || !engagementId}>
            {submitting ? 'Saving…' : 'Log'}
          </Button>
        </form>
        {clientHasNoActive && (
          <p
            style={{
              marginTop: 12,
              padding: 10,
              background: tokens.color.surface,
              border: `1px dashed ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              fontSize: 13,
              color: tokens.color.textMuted,
            }}
          >
            This client has no active engagements.{' '}
            <a
              href={`/engagements/new?clientId=${clientId}`}
              style={{ color: tokens.color.accent }}
            >
              Create one →
            </a>
          </p>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card
        title="My entries"
        action={
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
            {totalHours.toFixed(2)}h • ${(totalAmount / 100).toLocaleString()}
          </span>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<TimeEntry>
            columns={[
              { key: 'date', header: 'Date', render: (e) => e.entryDate },
              {
                key: 'hours',
                header: 'Hours',
                align: 'right',
                render: (e) => Number(e.hours).toFixed(2),
              },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                render: (e) => `$${(e.standardAmountCents / 100).toLocaleString()}`,
              },
              {
                key: 'flags',
                header: 'Flags',
                render: (e) => (
                  <span style={{ display: 'flex', gap: 4 }}>
                    {e.billableFlag ? (
                      <Pill tone="success">billable</Pill>
                    ) : (
                      <Pill tone="neutral">non-bill</Pill>
                    )}
                    {!e.inScopeFlag && <Pill tone="warning">OOS</Pill>}
                  </span>
                ),
              },
              { key: 'desc', header: 'Description', render: (e) => e.description },
            ]}
            rows={entries}
            rowKey={(e) => e.id}
            empty="No time logged yet."
          />
        )}
      </Card>
    </>
  );
}

function DayView({
  engagements,
  clients,
}: {
  engagements: Engagement[];
  clients: Client[];
}): JSX.Element {
  const [date, setDate] = useState(today());
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<{ items: TimeEntry[] }>(`/api/staff/time-entries/mine?start=${date}&end=${date}`).then(
      (r) => {
        if (cancelled) return;
        setEntries(r.items ?? []);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [date]);

  const total = entries.reduce((s, e) => s + Number(e.hours), 0);
  const billable = entries.filter((e) => e.billableFlag).reduce((s, e) => s + Number(e.hours), 0);
  const byEngagement = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const arr = m.get(e.engagementId) ?? [];
      arr.push(e);
      m.set(e.engagementId, arr);
    }
    return Array.from(m.entries()).map(([id, items]) => {
      const eng = engagements.find((e) => e.id === id);
      const cli = clients.find((c) => c.id === eng?.clientId);
      return {
        engagementId: id,
        engagementName: eng?.name ?? id.slice(0, 8),
        clientName: cli?.name ?? null,
        items,
        hours: items.reduce((s, e) => s + Number(e.hours), 0),
      };
    });
  }, [entries, engagements, clients]);

  return (
    <Card
      title="Day"
      action={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDate(addDays(date, -1))}
            aria-label="Previous day"
          >
            ‹
          </Button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={inputStyle}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDate(addDays(date, 1))}
            aria-label="Next day"
          >
            ›
          </Button>
          <Pill tone={total >= 7 ? 'success' : total >= 4 ? 'warning' : 'danger'}>
            {total.toFixed(2)}h ({billable.toFixed(2)} billable)
          </Pill>
        </div>
      }
    >
      {loading ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : byEngagement.length === 0 ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No time logged on {date}.</p>
      ) : (
        <div style={{ display: 'grid', gap: tokens.space.md }}>
          {byEngagement.map((g) => (
            <div
              key={g.engagementId}
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginBottom: 8,
                }}
              >
                <span>
                  {g.clientName && (
                    <span style={{ color: tokens.color.accent, fontSize: 14, fontWeight: 600 }}>
                      {g.clientName}
                      <span style={{ color: tokens.color.textMuted, margin: '0 6px' }}>·</span>
                    </span>
                  )}
                  <strong style={{ fontSize: 14 }}>{g.engagementName}</strong>
                </span>
                <span style={{ fontSize: 13, color: tokens.color.textMuted }}>
                  {g.hours.toFixed(2)}h
                </span>
              </div>
              {g.items.map((e) => (
                <div
                  key={e.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '60px 1fr auto',
                    gap: 8,
                    padding: '4px 0',
                    fontSize: 13,
                    borderTop: `1px solid ${tokens.color.border}`,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{Number(e.hours).toFixed(2)}h</span>
                  <span style={{ color: tokens.color.textMuted }}>
                    {e.description || <em>(no description)</em>}
                  </span>
                  <span style={{ display: 'flex', gap: 4 }}>
                    {e.billableFlag ? (
                      <Pill tone="success">billable</Pill>
                    ) : (
                      <Pill tone="neutral">non-bill</Pill>
                    )}
                    {!e.inScopeFlag && <Pill tone="warning">OOS</Pill>}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function WeekView({
  engagements,
  clients,
}: {
  engagements: Engagement[];
  clients: Client[];
}): JSX.Element {
  const [weekAnchor, setWeekAnchor] = useState(startOfWeek(today()));
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const weekEnd = useMemo(() => addDays(weekAnchor, 6), [weekAnchor]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i)),
    [weekAnchor],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<{ items: TimeEntry[] }>(
      `/api/staff/time-entries/mine?start=${weekAnchor}&end=${weekEnd}`,
    ).then((r) => {
      if (cancelled) return;
      setEntries(r.items ?? []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [weekAnchor, weekEnd]);

  // Build grid: rows = engagementId, columns = day → hours sum
  const grid = useMemo(() => {
    const byEng = new Map<string, Map<string, number>>();
    for (const e of entries) {
      const row = byEng.get(e.engagementId) ?? new Map<string, number>();
      row.set(e.entryDate, (row.get(e.entryDate) ?? 0) + Number(e.hours));
      byEng.set(e.engagementId, row);
    }
    const rows = Array.from(byEng.entries()).map(([id, dayMap]) => {
      const eng = engagements.find((e) => e.id === id);
      const cli = clients.find((c) => c.id === eng?.clientId);
      return {
        engagementId: id,
        engagementName: eng?.name ?? id.slice(0, 8),
        clientName: cli?.name ?? null,
        cells: days.map((d) => dayMap.get(d) ?? 0),
        total: Array.from(dayMap.values()).reduce((s, v) => s + v, 0),
      };
    });
    // Sort by client name (alphabetical) so each client's engagements
    // cluster — easier scan than pure hours-desc.
    rows.sort((a, b) => {
      const ca = (a.clientName ?? '').toLowerCase();
      const cb = (b.clientName ?? '').toLowerCase();
      if (ca !== cb) return ca.localeCompare(cb);
      return b.total - a.total;
    });
    return rows;
  }, [entries, days, engagements, clients]);

  const dailyTotals = useMemo(
    () =>
      days.map((d) =>
        entries.filter((e) => e.entryDate === d).reduce((s, e) => s + Number(e.hours), 0),
      ),
    [entries, days],
  );
  const weekTotal = dailyTotals.reduce((s, v) => s + v, 0);

  return (
    <Card
      title="Week"
      action={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setWeekAnchor(addDays(weekAnchor, -7))}
            aria-label="Previous week"
          >
            ‹ Prev
          </Button>
          <span style={{ fontSize: 13, color: tokens.color.textMuted }}>
            {shortDate(weekAnchor)} – {shortDate(weekEnd)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setWeekAnchor(addDays(weekAnchor, 7))}
            aria-label="Next week"
          >
            Next ›
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setWeekAnchor(startOfWeek(today()))}>
            This week
          </Button>
          <Pill tone={weekTotal >= 35 ? 'success' : weekTotal >= 20 ? 'warning' : 'danger'}>
            {weekTotal.toFixed(2)}h
          </Pill>
        </div>
      }
    >
      {loading ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
              minWidth: 700,
            }}
          >
            <thead>
              <tr>
                <th style={th('left')}>Engagement</th>
                {days.map((d) => (
                  <th key={d} style={th('right')}>
                    <div style={{ fontWeight: 600 }}>{dayLabel(d)}</div>
                    <div style={{ fontSize: 11, color: tokens.color.textMuted, fontWeight: 400 }}>
                      {shortDate(d)}
                    </div>
                  </th>
                ))}
                <th style={th('right')}>Total</th>
              </tr>
            </thead>
            <tbody>
              {grid.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    style={{ padding: 16, textAlign: 'center', color: tokens.color.textMuted }}
                  >
                    No time logged this week.
                  </td>
                </tr>
              ) : (
                grid.map((r) => (
                  <tr key={r.engagementId}>
                    <td style={td('left')}>
                      {r.clientName && (
                        <span style={{ color: tokens.color.accent, fontWeight: 600 }}>
                          {r.clientName}
                          <span style={{ color: tokens.color.textMuted, margin: '0 6px' }}>·</span>
                        </span>
                      )}
                      {r.engagementName}
                    </td>
                    {r.cells.map((h, i) => (
                      <td key={i} style={td('right', h > 0)}>
                        {h > 0 ? h.toFixed(2) : '–'}
                      </td>
                    ))}
                    <td style={{ ...td('right'), fontWeight: 600 }}>{r.total.toFixed(2)}</td>
                  </tr>
                ))
              )}
              <tr style={{ background: tokens.color.surface, fontWeight: 600 }}>
                <td style={td('left')}>Daily total</td>
                {dailyTotals.map((h, i) => (
                  <td
                    key={i}
                    style={{
                      ...td('right'),
                      color:
                        h >= 7
                          ? tokens.color.success
                          : h >= 4
                            ? tokens.color.warning
                            : tokens.color.textMuted,
                    }}
                  >
                    {h > 0 ? h.toFixed(2) : '–'}
                  </td>
                ))}
                <td style={td('right')}>{weekTotal.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function MonthView(): JSX.Element {
  const [monthsBack, setMonthsBack] = useState(6);
  const [days, setDays] = useState<DayTotal[]>([]);
  const [months, setMonths] = useState<MonthTotal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      api<{ items: MonthTotal[] }>(
        `/api/staff/time-entries/totals/by-month?monthsBack=${monthsBack}`,
      ),
      // pull last ~62 days of day totals for the heatmap
      (async () => {
        const end = today();
        const start = addDays(end, -62);
        return api<{ items: DayTotal[] }>(
          `/api/staff/time-entries/totals/by-day?start=${start}&end=${end}`,
        );
      })(),
    ]).then(([m, d]) => {
      if (cancelled) return;
      setMonths(m.items ?? []);
      setDays(d.items ?? []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [monthsBack]);

  const dayMap = useMemo(() => new Map(days.map((d) => [d.entryDate, d])), [days]);
  const heatmapDays = useMemo(() => {
    const end = today();
    return Array.from({ length: 62 }, (_, i) => addDays(end, -(61 - i)));
  }, []);

  function heatColor(hours: number): string {
    if (hours <= 0) return tokens.color.surface;
    if (hours < 4) return 'rgba(245, 158, 11, 0.3)'; // warning low
    if (hours < 7) return 'rgba(245, 158, 11, 0.7)'; // warning mid
    if (hours < 9) return 'rgba(34, 197, 94, 0.7)'; // success
    return 'rgba(34, 197, 94, 1)'; // success high
  }

  return (
    <>
      <Card
        title="Recent activity (62-day heatmap)"
        action={
          <Pill tone="neutral">
            {days.reduce((s, d) => s + d.hours, 0).toFixed(2)}h over {days.length} active days
          </Pill>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(31, 1fr)',
              gap: 2,
            }}
          >
            {heatmapDays.map((d) => {
              const h = dayMap.get(d)?.hours ?? 0;
              return (
                <div
                  key={d}
                  title={`${d}: ${h.toFixed(2)}h`}
                  style={{
                    aspectRatio: '1 / 1',
                    background: heatColor(h),
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: 2,
                  }}
                />
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title="Month rollup"
        action={
          <select
            value={monthsBack}
            onChange={(e) => setMonthsBack(Number(e.target.value))}
            style={inputStyle}
            aria-label="Months back"
          >
            <option value={3}>Last 3 months</option>
            <option value={6}>Last 6 months</option>
            <option value={12}>Last 12 months</option>
            <option value={24}>Last 24 months</option>
          </select>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : months.length === 0 ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No time in this window.</p>
        ) : (
          <Table<MonthTotal>
            columns={[
              { key: 'month', header: 'Month', render: (m) => m.month },
              {
                key: 'hours',
                header: 'Hours',
                align: 'right',
                render: (m) => m.hours.toFixed(2),
              },
              {
                key: 'amount',
                header: 'Standard $',
                align: 'right',
                render: (m) => `$${(m.amountCents / 100).toLocaleString()}`,
              },
              {
                key: 'count',
                header: 'Entries',
                align: 'right',
                render: (m) => m.count.toString(),
              },
            ]}
            rows={months}
            rowKey={(m) => m.month}
            empty="No months in window."
          />
        )}
      </Card>
    </>
  );
}

const inputStyle = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
} as const;

function th(align: 'left' | 'right'): React.CSSProperties {
  return {
    textAlign: align,
    padding: '8px',
    borderBottom: `1px solid ${tokens.color.border}`,
    fontSize: 12,
    fontWeight: 600,
    color: tokens.color.textMuted,
  };
}

function td(align: 'left' | 'right', emphasized = false): React.CSSProperties {
  return {
    textAlign: align,
    padding: '6px 8px',
    borderBottom: `1px solid ${tokens.color.border}`,
    color: emphasized ? tokens.color.text : tokens.color.textMuted,
    fontWeight: emphasized ? 500 : 400,
  };
}

function AiDescribeButton({
  engagementName,
  workCodeName,
  hours,
  onPick,
}: {
  engagementName: string | undefined;
  workCodeName: string | undefined;
  hours: number | undefined;
  onPick: (s: string) => void;
}): JSX.Element | null {
  const aiStatus = useAiStatus();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);

  async function suggest(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ suggestion: string }>('/api/staff/ai/suggest-description', {
        method: 'POST',
        body: JSON.stringify({ engagementName, workCodeName, hours }),
      });
      if (r.suggestion) {
        setLast(r.suggestion);
        onPick(r.suggestion);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  if (!aiUsable(aiStatus)) return null;
  return (
    <AiPanel
      title="Describe this entry"
      providerId={aiStatus?.providerId ?? undefined}
      busy={busy}
      error={err}
      action={
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void suggest()}
          disabled={busy || !engagementName}
        >
          {last ? 'Regenerate' : 'Suggest'}
        </Button>
      }
    >
      {last ? (
        <p style={{ margin: 0, fontSize: 12 }}>{last}</p>
      ) : (
        <p style={{ margin: 0, fontSize: 11, color: tokens.color.textMuted }}>
          Pick an engagement + work code, then ask the model for a description suggestion based on
          recent entries.
        </p>
      )}
    </AiPanel>
  );
}
