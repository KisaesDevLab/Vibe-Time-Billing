/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useMemo, useState } from 'react';

import { Button, Card, Combobox, Input, Pill, Printer, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { formatCents } from '../lib/money';
import { CreateClientWizard } from './clients/CreateClientWizard';
import { ImportClientsWizard } from './clients/ImportClientsWizard';
import { RollDueRecurrencesDialog } from './clients/RollDueRecurrencesDialog';
import { RouteSheetDialog } from './clients/RouteSheetDialog';

interface ClientRow {
  id: string;
  name: string;
  status: string;
  clientType: string;
  externalId: string | null;
  partnerInChargeId: string | null;
  partnerName: string | null;
  termsDays: number;
  invoiceConsolidationPreference: 'CONSOLIDATED' | 'SEPARATE';
  officeName: string | null;
  createdAt: string;
  outstandingBalanceCents: number;
  mailingCity: string | null;
  mailingState: string | null;
  // 0092 — when set, the client has at least one ACTIVE portal contact
  // and clicking the Status pill opens a view-as session against this
  // access row. NULL when no active portal access exists.
  activePortalAccessId: string | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

type SortCol =
  | 'name'
  | 'externalId'
  | 'clientType'
  | 'status'
  | 'partnerName'
  | 'officeName'
  | 'createdAt'
  | 'outstandingBalanceCents';

// Session-persisted filters/sort — survives refresh + navigation, same
// lifetime as the other table views.
const STORAGE_KEY = 'vibe.clients.view';

interface PersistedView {
  q: string;
  clientOwnerId: string;
  clientType: string;
  status: string;
  officeId: string;
  sort: { col: SortCol; dir: 'asc' | 'desc' };
}

const DEFAULT_VIEW: PersistedView = {
  q: '',
  clientOwnerId: '',
  clientType: '',
  status: '',
  officeId: '',
  sort: { col: 'name', dir: 'asc' },
};

function loadView(): PersistedView {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VIEW;
    return { ...DEFAULT_VIEW, ...(JSON.parse(raw) as Partial<PersistedView>) };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function ClientsPage(): JSX.Element {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  // 0092 — multi-select replaces the legacy pin column. The bulk-email
  // toolbar action enables when at least one row is selected.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  // Route-sheet printing — the client whose dialog is open (or null).
  const [routeSheetClient, setRouteSheetClient] = useState<ClientRow | null>(null);
  const initial = useMemo(() => loadView(), []);
  const [q, setQ] = useState(initial.q);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rollOpen, setRollOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // 0050 — filters (hydrated from sessionStorage)
  const [clientOwnerId, setClientOwnerId] = useState<string>(initial.clientOwnerId);
  const [clientType, setClientType] = useState<string>(initial.clientType);
  const [statusFilter, setStatusFilter] = useState<string>(initial.status);
  // 0092 — office filter chip. Multi-office firms can scope the list
  // to a single office; '' = all offices.
  const [officeFilter, setOfficeFilter] = useState<string>(initial.officeId);
  const [officeOptions, setOfficeOptions] = useState<
    Array<{ id: string; name: string; isDefault: boolean }>
  >([]);

  // 0050 — pagination + sort
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<{ col: SortCol; dir: 'asc' | 'desc' }>(initial.sort);

  // Persist the view for the session whenever a filter/sort changes.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          q,
          clientOwnerId,
          clientType,
          status: statusFilter,
          officeId: officeFilter,
          sort,
        } satisfies PersistedView),
      );
    } catch {
      /* storage unavailable — in-memory only */
    }
  }, [q, clientOwnerId, clientType, statusFilter, officeFilter, sort]);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
      if (clientType) params.set('clientType', clientType);
      if (statusFilter) params.set('status', statusFilter);
      if (officeFilter) params.set('officeId', officeFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      params.set('sort', sort.col);
      params.set('dir', sort.dir);
      // Fetch in parallel; tolerate the secondary calls failing (e.g.
      // a staff user without app_user:read perm) so the client list
      // still renders even if the filter dropdowns are empty.
      const [r, u, o] = await Promise.all([
        api<{ rows: ClientRow[]; total: number }>(`/api/staff/clients?${params.toString()}`),
        api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
        api<{ offices: Array<{ id: string; name: string; isDefault: boolean }> }>(
          '/api/staff/admin/offices',
        ).catch(() => ({ offices: [] })),
      ]);
      setClients(r.rows ?? []);
      setTotal(r.total ?? 0);
      setUsers(u.users ?? []);
      setOfficeOptions(o.offices ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, sort, clientOwnerId, clientType, statusFilter, officeFilter]);

  function toggleSelect(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll(): void {
    setSelectedIds((prev) =>
      prev.size === clients.length ? new Set() : new Set(clients.map((c) => c.id)),
    );
  }

  async function viewAsClient(c: ClientRow): Promise<void> {
    if (!c.activePortalAccessId) return;
    try {
      const r = await api<{ portalUrl: string }>(`/api/staff/clients/${c.id}/impersonate`, {
        method: 'POST',
        body: JSON.stringify({ accessId: c.activePortalAccessId }),
      });
      window.open(r.portalUrl, '_blank', 'noopener,noreferrer');
    } catch {
      // Non-fatal; user can retry from the client detail page.
    }
  }

  function toggleSort(col: SortCol): void {
    setSort((prev) =>
      prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    );
    setPage(1);
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const sortIcon = (col: SortCol): string =>
    sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  // Server sorts the data — we render rows as returned.
  const sortedDisplay = clients;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400 }}>
      <Card
        title="Clients"
        action={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {selectedIds.size > 0 && (
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                {selectedIds.size} selected
              </span>
            )}
            <Button
              variant={selectedIds.size > 0 ? 'secondary' : 'ghost'}
              disabled={selectedIds.size === 0}
              onClick={() => setBulkEmailOpen(true)}
            >
              Send email
            </Button>
            <Button variant="secondary" onClick={() => setRollOpen(true)}>
              Roll due recurrences
            </Button>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              Import clients
            </Button>
            <Button onClick={() => setWizardOpen(true)}>+ New client</Button>
          </div>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void load();
          }}
          style={{ display: 'grid', gap: 8, gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto' }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, external ID, email, phone, custom fields"
          />
          <Combobox
            ariaLabel="Client owner"
            clearable
            value={clientOwnerId}
            onChange={(v) => {
              setPage(1);
              setClientOwnerId(v);
            }}
            options={users.map((u) => ({ value: u.id, label: u.fullName }))}
            placeholder="Any owner"
          />
          <Combobox
            ariaLabel="Office"
            clearable
            value={officeFilter}
            onChange={(v) => {
              setPage(1);
              setOfficeFilter(v);
            }}
            options={officeOptions.map((o) => ({
              value: o.id,
              label: o.isDefault ? `${o.name} (default)` : o.name,
            }))}
            placeholder="Any office"
          />
          <Combobox
            ariaLabel="Client type"
            clearable
            value={clientType}
            onChange={(v) => {
              setPage(1);
              setClientType(v);
            }}
            options={[
              { value: 'INDIVIDUAL', label: 'Individual' },
              { value: 'BUSINESS', label: 'Business' },
            ]}
            placeholder="Any type"
          />
          <Combobox
            ariaLabel="Status"
            clearable
            value={statusFilter}
            onChange={(v) => {
              setPage(1);
              setStatusFilter(v);
            }}
            options={[
              { value: 'ACTIVE', label: 'Active' },
              { value: 'INACTIVE', label: 'Inactive' },
              { value: 'ARCHIVED', label: 'Archived' },
              { value: 'PROSPECT', label: 'Prospect' },
            ]}
            placeholder="Any status"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </Card>

      <CreateClientWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => void load()}
        users={users}
      />

      <ImportClientsWizard
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onCreated={() => void load()}
        users={users}
        offices={officeOptions}
      />

      {rollOpen && <RollDueRecurrencesDialog onClose={() => setRollOpen(false)} />}

      {routeSheetClient && (
        <RouteSheetDialog
          clientId={routeSheetClient.id}
          clientName={routeSheetClient.name}
          onClose={() => setRouteSheetClient(null)}
        />
      )}

      {bulkEmailOpen && (
        <BulkEmailDialog
          targets={clients.filter((c) => selectedIds.has(c.id))}
          onClose={() => setBulkEmailOpen(false)}
          onSent={() => {
            setBulkEmailOpen(false);
            setSelectedIds(new Set());
          }}
        />
      )}

      <Card
        title={`Results — ${total.toLocaleString()} client${total === 1 ? '' : 's'}`}
        action={
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              Page size
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Page size"
                style={{ padding: '4px 6px', borderRadius: tokens.radius.sm }}
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
            </label>
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </Button>
            <span style={{ color: tokens.color.textMuted }}>
              Page {page} / {pageCount}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next →
            </Button>
          </span>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<ClientRow>
            columns={[
              {
                key: 'select',
                header: (
                  <input
                    type="checkbox"
                    aria-label="Select all visible clients"
                    checked={selectedIds.size === clients.length && clients.length > 0}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate =
                          selectedIds.size > 0 && selectedIds.size < clients.length;
                      }
                    }}
                    onChange={toggleSelectAll}
                  />
                ) as unknown as string,
                render: (c) => (
                  <input
                    type="checkbox"
                    aria-label={`Select ${c.name}`}
                    checked={selectedIds.has(c.id)}
                    onChange={() => toggleSelect(c.id)}
                  />
                ),
              },
              {
                key: 'name',
                header: (
                  <button type="button" onClick={() => toggleSort('name')} style={headerBtn}>
                    Name{sortIcon('name')}
                  </button>
                ) as unknown as string,
                render: (c) => <a href={`/clients/${c.id}`}>{c.name}</a>,
              },
              {
                key: 'owner',
                header: (
                  <button type="button" onClick={() => toggleSort('partnerName')} style={headerBtn}>
                    Owner{sortIcon('partnerName')}
                  </button>
                ) as unknown as string,
                render: (c) => c.partnerName ?? '—',
              },
              {
                key: 'externalId',
                header: (
                  <button type="button" onClick={() => toggleSort('externalId')} style={headerBtn}>
                    External ID{sortIcon('externalId')}
                  </button>
                ) as unknown as string,
                render: (c) => c.externalId ?? '—',
              },
              {
                key: 'type',
                header: (
                  <button type="button" onClick={() => toggleSort('clientType')} style={headerBtn}>
                    Type{sortIcon('clientType')}
                  </button>
                ) as unknown as string,
                render: (c) => <Pill>{c.clientType}</Pill>,
              },
              {
                key: 'outstanding',
                header: (
                  <button
                    type="button"
                    onClick={() => toggleSort('outstandingBalanceCents')}
                    style={headerBtn}
                  >
                    Outstanding Bal.{sortIcon('outstandingBalanceCents')}
                  </button>
                ) as unknown as string,
                align: 'right',
                render: (c) => (
                  <span
                    style={{
                      color:
                        (c.outstandingBalanceCents ?? 0) > 0
                          ? tokens.color.text
                          : tokens.color.textMuted,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatCents(c.outstandingBalanceCents ?? 0)}
                  </span>
                ),
              },
              {
                key: 'office',
                header: (
                  <button type="button" onClick={() => toggleSort('officeName')} style={headerBtn}>
                    Office{sortIcon('officeName')}
                  </button>
                ) as unknown as string,
                render: (c) => c.officeName ?? '—',
              },
              {
                key: 'status',
                header: (
                  <button type="button" onClick={() => toggleSort('status')} style={headerBtn}>
                    Status{sortIcon('status')}
                  </button>
                ) as unknown as string,
                render: (c) => {
                  // 0092 — when an active portal access exists, the pill
                  // renders filled (white text on accent fill) and acts as
                  // a "view as client" button. Without an active access it
                  // stays plain.
                  const hasPortal = c.activePortalAccessId != null;
                  if (hasPortal) {
                    return (
                      <button
                        type="button"
                        onClick={() => void viewAsClient(c)}
                        title="Open portal as this client (impersonation, 5-min token)"
                        style={{
                          display: 'inline-flex',
                          padding: '2px 8px',
                          fontSize: 11,
                          fontWeight: 600,
                          borderRadius: 999,
                          background: tokens.color.accent,
                          color: '#fff',
                          border: 'none',
                          cursor: 'pointer',
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                        }}
                      >
                        {c.status} · view as ↗
                      </button>
                    );
                  }
                  return (
                    <Pill tone={c.status === 'ACTIVE' ? 'success' : 'neutral'}>{c.status}</Pill>
                  );
                },
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (c) => (
                  <button
                    type="button"
                    onClick={() => setRouteSheetClient(c)}
                    title="Print route sheet"
                    aria-label={`Print route sheet for ${c.name}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 30,
                      height: 30,
                      borderRadius: tokens.radius.sm,
                      border: `1px solid ${tokens.color.border}`,
                      background: 'transparent',
                      color: tokens.color.accent,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    <Printer size={16} />
                  </button>
                ),
              },
            ]}
            rows={sortedDisplay}
            rowKey={(c) => c.id}
            empty="No clients match the current filters."
          />
        )}
      </Card>
    </div>
  );
}

const headerBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  fontFamily: 'inherit',
  fontWeight: 'inherit',
  fontSize: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
};

// ---------------------------------------------------------------------
// BulkEmailDialog — compose a single subject/body and POST to
// /api/staff/clients/bulk-email which fans out to each client's primary
// (or billing, or first-with-email) contact. Shows per-client outcomes
// on completion so the partner can see skipped/no-contact rows.
// ---------------------------------------------------------------------

interface BulkEmailResult {
  results: Array<{
    clientId: string;
    clientName: string;
    sent: boolean;
    to: string | null;
    reason: string | null;
  }>;
  summary: { requested: number; sent: number; skipped: number };
}

function BulkEmailDialog({
  targets,
  onClose,
  onSent,
}: {
  targets: ClientRow[];
  onClose: () => void;
  onSent: () => void;
}): JSX.Element {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkEmailResult | null>(null);

  async function send(): Promise<void> {
    if (!subject.trim() || !body.trim()) {
      setError('Subject and body are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<BulkEmailResult>('/api/staff/clients/bulk-email', {
        method: 'POST',
        body: JSON.stringify({
          clientIds: targets.map((t) => t.id),
          subject: subject.trim(),
          body: body.trim(),
        }),
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'send_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 56,
        zIndex: 200,
      }}
    >
      <div style={{ minWidth: 560, maxWidth: 720, maxHeight: '85vh', overflow: 'auto' }}>
        <Card title="Send email to selected clients">
          {!result ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <p style={{ fontSize: 13, margin: 0 }}>
                One message will be sent to each of <strong>{targets.length}</strong> client
                {targets.length === 1 ? '' : 's'} — to their primary contact (or billing, or first
                contact with an email).
              </p>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  style={{
                    padding: '8px 10px',
                    fontSize: 13,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.bg,
                    color: tokens.color.text,
                  }}
                />
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Body</label>
                <textarea
                  rows={8}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  style={{
                    padding: '8px 10px',
                    fontSize: 13,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.bg,
                    color: tokens.color.text,
                    resize: 'vertical',
                  }}
                />
              </div>
              {error && (
                <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
                  {error}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  disabled={busy || !subject.trim() || !body.trim()}
                  onClick={() => void send()}
                >
                  {busy ? 'Sending…' : `Send to ${targets.length}`}
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={{ fontSize: 13, margin: 0 }}>
                <strong>Done.</strong> {result.summary.sent} sent · {result.summary.skipped}{' '}
                skipped.
              </p>
              <ul
                style={{
                  margin: 0,
                  padding: '8px 16px',
                  background: tokens.color.surface,
                  borderRadius: tokens.radius.sm,
                  fontSize: 12,
                  maxHeight: 240,
                  overflow: 'auto',
                }}
              >
                {result.results.map((r) => (
                  <li key={r.clientId} style={{ marginBottom: 4 }}>
                    <strong>{r.clientName}</strong> —{' '}
                    {r.sent ? (
                      <span style={{ color: tokens.color.success }}>sent to {r.to}</span>
                    ) : (
                      <span style={{ color: tokens.color.warning }}>
                        skipped ({r.reason ?? 'unknown'})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button onClick={onSent}>Close</Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
