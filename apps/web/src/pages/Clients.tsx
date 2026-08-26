/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useMemo, useState } from 'react';

import { Button, Card, ColumnFilter, Pill, Printer, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { TableSearch } from '../components/TableSearch';
import { ENTITY_TYPE_LABELS, ENTITY_TYPE_OPTIONS, type EntityType } from '../lib/entity-types';
import { useColumnView, viewToPagedQuery } from '../lib/column-view';
import { usePagedList } from '../lib/use-paged-list';
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
  entityType: EntityType | null;
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
  // Comma-joined names (max 3) of this client's people that matched the
  // search text. NULL when not searching or when the client itself matched.
  matchedPeople: string | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

export function ClientsPage(): JSX.Element {
  const [users, setUsers] = useState<AppUser[]>([]);
  // 0092 — multi-select replaces the legacy pin column. The bulk-email
  // toolbar action enables when at least one row is selected. Selection
  // persists the minimal {id,name} per row so it survives server-side
  // paging (rows on other pages aren't in memory).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedMeta, setSelectedMeta] = useState<Map<string, { id: string; name: string }>>(
    new Map(),
  );
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [mailMergeOpen, setMailMergeOpen] = useState(false);
  // Route-sheet printing — the client whose dialog is open (or null).
  const [routeSheetClient, setRouteSheetClient] = useState<ClientRow | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rollOpen, setRollOpen] = useState(false);
  const [officeOptions, setOfficeOptions] = useState<
    Array<{ id: string; name: string; isDefault: boolean }>
  >([]);

  // Standard table view: filter / sort / search state (sessionStorage-
  // persisted) via useColumnView; the actual filtering/sorting/paging runs
  // SERVER-side (3000+ clients outgrow a single capped fetch). The `.v2` key
  // discards stale pre-migration filters (owner/office now hold ids, not names).
  const view = useColumnView('vibe.clients.view.v2', { sortCol: 'name', sortDir: 'asc' });
  const query = useMemo(
    () =>
      viewToPagedQuery(view, {
        // column key → server sort key (identity keys omitted)
        sortMap: {
          owner: 'partnerName',
          type: 'clientType',
          entity: 'entityType',
          outstanding: 'outstandingBalanceCents',
          office: 'officeName',
        },
        // column key → server filter param (values are ids for owner/office,
        // enum strings for type/entity/status — see the ColumnFilter `values` below)
        filterMap: {
          owner: 'clientOwnerId',
          type: 'clientType',
          entity: 'entityType',
          office: 'officeId',
          status: 'status',
        },
      }),
    [view],
  );
  const list = usePagedList<ClientRow>('/api/staff/clients', { query });
  const loading = list.loading;

  // Aux data for the wizards + filter option lists. Loaded once; tolerate
  // failure (e.g. a staff user without app_user:read perm) so the list still
  // renders. Filter options are sourced HERE, not from the loaded page.
  async function loadAux(): Promise<void> {
    const [u, o] = await Promise.all([
      api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
      api<{ offices: Array<{ id: string; name: string; isDefault: boolean }> }>(
        '/api/staff/admin/offices',
      ).catch(() => ({ offices: [] })),
    ]);
    setUsers(u.users ?? []);
    setOfficeOptions(o.offices ?? []);
  }
  useEffect(() => {
    void loadAux();
  }, []);

  // Column-filter option lists — value is what the server matches on.
  const ownerValues = useMemo(
    () =>
      [...users]
        .sort((a, b) => a.fullName.localeCompare(b.fullName))
        .map((u) => ({ value: u.id, label: u.fullName })),
    [users],
  );
  const officeValues = useMemo(
    () =>
      [...officeOptions]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((o) => ({ value: o.id, label: o.name })),
    [officeOptions],
  );
  const typeValues = [
    { value: 'INDIVIDUAL', label: 'INDIVIDUAL' },
    { value: 'BUSINESS', label: 'BUSINESS' },
  ];
  const statusValues = [
    { value: 'ACTIVE', label: 'ACTIVE' },
    { value: 'ARCHIVED', label: 'ARCHIVED' },
    { value: 'PROSPECT', label: 'PROSPECT' },
    { value: 'INACTIVE', label: 'INACTIVE' },
  ];

  function toggleSelect(c: ClientRow): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
    setSelectedMeta((prev) => {
      const next = new Map(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, { id: c.id, name: c.name });
      return next;
    });
  }
  // Select-all toggles the CURRENT page (other pages aren't loaded).
  function toggleSelectAll(): void {
    const pageIds = list.rows.map((c) => c.id);
    const allOnPage = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
    setSelectedMeta((prev) => {
      const next = new Map(prev);
      if (allOnPage) list.rows.forEach((c) => next.delete(c.id));
      else list.rows.forEach((c) => next.set(c.id, { id: c.id, name: c.name }));
      return next;
    });
  }
  function clearSelection(): void {
    setSelectedIds(new Set());
    setSelectedMeta(new Map());
  }
  const selectedTargets = Array.from(selectedMeta.values());

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
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
          placeholder="Search name, external ID, people, custom fields…"
          width={420}
        />
      </Card>

      <CreateClientWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => {
          list.reload();
          void loadAux();
        }}
        users={users}
      />

      <ImportClientsWizard
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onCreated={() => {
          list.reload();
          void loadAux();
        }}
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
          targets={selectedTargets}
          onClose={() => setBulkEmailOpen(false)}
          onSent={() => {
            setBulkEmailOpen(false);
            clearSelection();
          }}
        />
      )}

      {mailMergeOpen && (
        <MailMergeDialog
          targets={selectedTargets}
          onClose={() => setMailMergeOpen(false)}
          onDone={() => {
            setMailMergeOpen(false);
            clearSelection();
          }}
        />
      )}

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Results</span>
            {list.total > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {view.anyFilterActive
                  ? `${list.total} match${list.total === 1 ? '' : 'es'}`
                  : `${list.total} client${list.total === 1 ? '' : 's'}`}
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
                mobile: 'actions',
                header: (
                  <input
                    type="checkbox"
                    aria-label="Select all clients on this page"
                    checked={list.rows.length > 0 && list.rows.every((c) => selectedIds.has(c.id))}
                    ref={(el) => {
                      if (el) {
                        const onPage = list.rows.filter((c) => selectedIds.has(c.id)).length;
                        el.indeterminate = onPage > 0 && onPage < list.rows.length;
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
                    onChange={() => toggleSelect(c)}
                  />
                ),
              },
              {
                key: 'name',
                mobile: 'title',
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
                render: (c) => (
                  <>
                    <a href={`/clients/${c.id}`}>{c.name}</a>
                    {c.matchedPeople && (
                      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                        {c.matchedPeople}
                      </div>
                    )}
                  </>
                ),
              },
              {
                key: 'owner',
                mobile: 'field',
                mobileLabel: 'Owner',
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
                mobile: 'meta',
                mobileLabel: 'Client ID',
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
                mobile: 'field',
                mobileLabel: 'Type',
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
                key: 'entity',
                mobile: 'field',
                mobileLabel: 'Entity',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Entity{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort entity type"
                      values={ENTITY_TYPE_OPTIONS}
                      selected={view.filterFor('entity')}
                      sort={view.sortFor('entity')}
                      onApply={(sel, dir) => view.apply('entity', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (c) => (c.entityType ? ENTITY_TYPE_LABELS[c.entityType] : '—'),
              },
              {
                key: 'outstanding',
                mobile: 'field',
                mobileLabel: 'Outstanding',
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
                mobile: 'field',
                mobileLabel: 'Office',
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
                mobile: 'badge',
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
                mobile: 'actions',
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
            rows={list.rows}
            rowKey={(c) => c.id}
            empty="No clients match the current filters."
            pagination={list.pagination}
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
  targets: Array<{ id: string; name: string }>;
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
              <div
                style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}
              >
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
