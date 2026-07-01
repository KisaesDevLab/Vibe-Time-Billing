/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useMemo, useState } from 'react';

import { Button, Card, ColumnFilter, Pill, Printer, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { TableSearch } from '../components/TableSearch';
import { distinctOptions, selectRows, useColumnView } from '../lib/column-view';
import { formatCents } from '../lib/money';
import { CreateClientWizard } from './clients/CreateClientWizard';
import { ImportClientsWizard } from './clients/ImportClientsWizard';
import { MailMergeDialog } from './clients/MailMergeDialog';
import { RichTextEditor, type RichTextVariable } from '../proposal-editor/RichTextEditor';

// Merge tokens available in a client email body/subject. Resolved per-recipient
// on the server before send.
const EMAIL_VARIABLES: RichTextVariable[] = [
  { token: 'client.name', label: 'Client name' },
  { token: 'client.primaryContact', label: 'Primary contact name' },
  { token: 'firm.name', label: 'Firm name' },
  { token: 'firm.displayName', label: 'Firm display name' },
  { token: 'firm.support_email', label: 'Firm support email' },
  { token: 'firm.support_phone', label: 'Firm support phone' },
];
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
  // 0165 — per-client visibility restriction badge.
  restricted?: boolean;
  // 0092 — when set, the client has at least one ACTIVE portal contact
  // and clicking the Status pill opens a view-as session against this
  // access row. NULL when no active portal access exists.
  activePortalAccessId: string | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

export function ClientsPage(): JSX.Element {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  // 0092 — multi-select replaces the legacy pin column. The bulk-email
  // toolbar action enables when at least one row is selected.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [mailMergeOpen, setMailMergeOpen] = useState(false);
  // Route-sheet printing — the client whose dialog is open (or null).
  const [routeSheetClient, setRouteSheetClient] = useState<ClientRow | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rollOpen, setRollOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [officeOptions, setOfficeOptions] = useState<
    Array<{ id: string; name: string; isDefault: boolean }>
  >([]);

  // Standard table view: load the full firm set once, then filter / sort /
  // search run client-side (sessionStorage-persisted) via useColumnView.
  const view = useColumnView('vibe.clients.view', { sortCol: 'name', sortDir: 'asc' });

  async function load(): Promise<void> {
    setLoading(true);
    try {
      // Fetch in parallel; tolerate the secondary calls failing (e.g.
      // a staff user without app_user:read perm) so the client list
      // still renders even if the create/import wizards lack their data.
      const [r, u, o] = await Promise.all([
        api<{ rows?: ClientRow[]; items?: ClientRow[] }>('/api/staff/clients'),
        api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
        api<{ offices: Array<{ id: string; name: string; isDefault: boolean }> }>(
          '/api/staff/admin/offices',
        ).catch(() => ({ offices: [] })),
      ]);
      setClients(r.rows ?? r.items ?? []);
      setUsers(u.users ?? []);
      setOfficeOptions(o.offices ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(
    () =>
      selectRows(clients, view, {
        searchText: (c) =>
          `${c.name} ${c.externalId ?? ''} ${c.partnerName ?? ''} ${c.officeName ?? ''}`,
        filters: {
          owner: (c) => c.partnerName ?? '—',
          type: (c) => c.clientType,
          office: (c) => c.officeName ?? '—',
          status: (c) => c.status,
        },
        sortValues: {
          name: (c) => c.name,
          owner: (c) => c.partnerName ?? '',
          externalId: (c) => c.externalId ?? '',
          type: (c) => c.clientType,
          outstanding: (c) => c.outstandingBalanceCents ?? 0,
          office: (c) => c.officeName ?? '',
          status: (c) => c.status,
        },
        tieBreak: (a, b) => a.name.localeCompare(b.name),
      }),
    [clients, view],
  );

  const ownerValues = useMemo(
    () => distinctOptions(clients.map((c) => c.partnerName ?? '—')),
    [clients],
  );
  const officeValues = useMemo(
    () => distinctOptions(clients.map((c) => c.officeName ?? '—')),
    [clients],
  );
  const typeValues = useMemo(() => distinctOptions(clients.map((c) => c.clientType)), [clients]);
  const statusValues = useMemo(() => distinctOptions(clients.map((c) => c.status)), [clients]);

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
      prev.size === visible.length && visible.length > 0
        ? new Set()
        : new Set(visible.map((c) => c.id)),
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
            <Button
              variant={selectedIds.size > 0 ? 'secondary' : 'ghost'}
              disabled={selectedIds.size === 0}
              onClick={() => setMailMergeOpen(true)}
            >
              Mail merge letter
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
        <TableSearch
          view={view}
          placeholder="Search name, external ID, owner, office…"
          width={420}
        />
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

      {mailMergeOpen && (
        <MailMergeDialog
          targets={clients
            .filter((c) => selectedIds.has(c.id))
            .map((c) => ({ id: c.id, name: c.name }))}
          onClose={() => setMailMergeOpen(false)}
          onDone={() => {
            setMailMergeOpen(false);
            setSelectedIds(new Set());
          }}
        />
      )}

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Results</span>
            {clients.length > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {visible.length === clients.length
                  ? `${clients.length} client${clients.length === 1 ? '' : 's'}`
                  : `${visible.length} of ${clients.length}`}
              </span>
            )}
          </span>
        }
        action={
          view.anyFilterActive ? (
            <button
              type="button"
              onClick={view.clearFilters}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.color.accent,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          ) : undefined
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
                    checked={selectedIds.size === visible.length && visible.length > 0}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate =
                          selectedIds.size > 0 && selectedIds.size < visible.length;
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Name{' '}
                    <ColumnFilter
                      ariaLabel="Sort by name"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('name')}
                      onApply={(_, dir) => view.apply('name', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (c) => <a href={`/clients/${c.id}`}>{c.name}</a>,
              },
              {
                key: 'owner',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Owner{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort owner"
                      values={ownerValues}
                      selected={view.filterFor('owner')}
                      sort={view.sortFor('owner')}
                      onApply={(sel, dir) => view.apply('owner', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (c) => c.partnerName ?? '—',
              },
              {
                key: 'externalId',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    External ID{' '}
                    <ColumnFilter
                      ariaLabel="Sort by external ID"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('externalId')}
                      onApply={(_, dir) => view.apply('externalId', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (c) => c.externalId ?? '—',
              },
              {
                key: 'type',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Type{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort type"
                      values={typeValues}
                      selected={view.filterFor('type')}
                      searchable={false}
                      sort={view.sortFor('type')}
                      onApply={(sel, dir) => view.apply('type', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (c) => <Pill>{c.clientType}</Pill>,
              },
              {
                key: 'outstanding',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Outstanding Bal.{' '}
                    <ColumnFilter
                      ariaLabel="Sort by outstanding balance"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('outstanding')}
                      onApply={(_, dir) => view.apply('outstanding', new Set(), dir)}
                    />
                  </span>
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Office{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort office"
                      values={officeValues}
                      selected={view.filterFor('office')}
                      sort={view.sortFor('office')}
                      onApply={(sel, dir) => view.apply('office', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (c) => c.officeName ?? '—',
              },
              {
                key: 'status',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Status{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort status"
                      values={statusValues}
                      selected={view.filterFor('status')}
                      searchable={false}
                      sort={view.sortFor('status')}
                      onApply={(sel, dir) => view.apply('status', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (c) => {
                  // 0092 — when an active portal access exists, the pill
                  // renders filled (white text on accent fill) and acts as
                  // a "view as client" button. Without an active access it
                  // stays plain.
                  const hasPortal = c.activePortalAccessId != null;
                  // 0165 — restricted-client badge sits next to the status.
                  const restrictedBadge = c.restricted ? (
                    <Pill tone="warning">Restricted</Pill>
                  ) : null;
                  if (hasPortal) {
                    return (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
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
                        {restrictedBadge}
                      </span>
                    );
                  }
                  return (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <Pill tone={c.status === 'ACTIVE' ? 'success' : 'neutral'}>{c.status}</Pill>
                      {restrictedBadge}
                    </span>
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
            rows={visible}
            rowKey={(c) => c.id}
            empty="No clients match the current filters."
          />
        )}
      </Card>
    </div>
  );
}

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
      <div
        style={{
          width: 'min(900px, 94vw)',
          maxWidth: 900,
          maxHeight: '90vh',
          overflow: 'auto',
        }}
      >
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
                <RichTextEditor
                  value={body}
                  onChange={setBody}
                  variables={EMAIL_VARIABLES}
                  minHeight={300}
                />
                <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  Format with the toolbar and insert variables like{' '}
                  <code>{'{{ client.name }}'}</code> — filled in per recipient when sent.
                </span>
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
