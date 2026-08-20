// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client picker for Admin → Bulk engagements. Selecting thousands of
// clients through a dropdown doesn't scale, so this mirrors the Clients
// list instead: the same server-side filters (search, owner, type,
// entity, office, status) over the paginated /api/staff/clients API,
// with a checkbox table. Selection is ADDITIVE and survives filter and
// page changes — filter to one slice, "Add all matching", re-filter,
// add more. The running selection is always visible and reviewable.

import { useEffect, useRef, useState } from 'react';

import { Button, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { ENTITY_TYPE_LABELS, ENTITY_TYPE_OPTIONS, type EntityType } from '../../lib/entity-types';

export interface SelectedClient {
  id: string;
  name: string;
}

interface ClientRow {
  id: string;
  name: string;
  externalId: string | null;
  clientType: string;
  entityType: EntityType | null;
  partnerName: string | null;
  officeName: string | null;
  status: string;
}

const PAGE_SIZE = 25;
const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PROSPECT', label: 'Prospect' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: '', label: 'Any status (incl. archived)' },
];

export function BulkClientPicker({
  selected,
  onChange,
}: {
  selected: SelectedClient[];
  onChange: (next: SelectedClient[]) => void;
}): JSX.Element {
  // Filters — same server params as the Clients list view.
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [clientType, setClientType] = useState('');
  const [entityType, setEntityType] = useState('');
  const [officeId, setOfficeId] = useState('');
  const [status, setStatus] = useState('ACTIVE');

  const [rows, setRows] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [addingAll, setAddingAll] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [owners, setOwners] = useState<{ id: string; fullName: string }[]>([]);
  const [offices, setOffices] = useState<{ id: string; name: string }[]>([]);

  const selectedIds = new Set(selected.map((s) => s.id));
  const fetchSeq = useRef(0);

  // Debounce the search box so each keystroke doesn't hit the server.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // Filter option sources (best-effort — the table works without them).
  useEffect(() => {
    void api<{ users: { id: string; fullName: string; status: string }[] }>(
      '/api/staff/admin/users',
    )
      .then((r) => setOwners((r.users ?? []).filter((u) => u.status === 'ACTIVE')))
      .catch(() => setOwners([]));
    void api<{ offices: { id: string; name: string }[] }>('/api/staff/admin/offices')
      .then((r) => setOffices(r.offices ?? []))
      .catch(() => setOffices([]));
  }, []);

  function filterParams(): URLSearchParams {
    const p = new URLSearchParams({ sort: 'name', dir: 'asc' });
    if (debouncedQ) p.set('q', debouncedQ);
    if (ownerId) p.set('clientOwnerId', ownerId);
    if (clientType) p.set('clientType', clientType);
    if (entityType) p.set('entityType', entityType);
    if (officeId) p.set('officeId', officeId);
    if (status) p.set('status', status);
    return p;
  }

  // Reset to page 1 whenever a filter changes.
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, ownerId, clientType, entityType, officeId, status]);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setErr(null);
    const p = filterParams();
    p.set('page', String(page));
    p.set('pageSize', String(PAGE_SIZE));
    void api<{ rows: ClientRow[]; total: number }>(`/api/staff/clients?${p.toString()}`)
      .then((r) => {
        if (seq !== fetchSeq.current) return; // a newer fetch superseded this one
        setRows(r.rows ?? []);
        setTotal(Number(r.total ?? 0));
      })
      .catch((e) => {
        if (seq !== fetchSeq.current) return;
        setErr(e instanceof Error ? e.message : 'load_failed');
      })
      .finally(() => {
        if (seq === fetchSeq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedQ, ownerId, clientType, entityType, officeId, status]);

  function toggle(row: ClientRow): void {
    if (selectedIds.has(row.id)) {
      onChange(selected.filter((s) => s.id !== row.id));
    } else {
      onChange([...selected, { id: row.id, name: row.name }]);
    }
  }

  function addPage(): void {
    const additions = rows
      .filter((r) => !selectedIds.has(r.id))
      .map((r) => ({ id: r.id, name: r.name }));
    if (additions.length > 0) onChange([...selected, ...additions]);
  }

  function removePage(): void {
    const pageIds = new Set(rows.map((r) => r.id));
    onChange(selected.filter((s) => !pageIds.has(s.id)));
  }

  const pageAllSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));

  // Add every client matching the current filters, across all pages.
  async function addAllMatching(): Promise<void> {
    setAddingAll(true);
    setErr(null);
    try {
      const additions = new Map(selected.map((s) => [s.id, s] as const));
      const pages = Math.max(1, Math.ceil(total / 500));
      for (let pg = 1; pg <= pages; pg++) {
        const p = filterParams();
        p.set('page', String(pg));
        p.set('pageSize', '500');
        const r = await api<{ rows: ClientRow[] }>(`/api/staff/clients?${p.toString()}`);
        for (const row of r.rows ?? []) {
          if (!additions.has(row.id)) additions.set(row.id, { id: row.id, name: row.name });
        }
        if ((r.rows ?? []).length < 500) break;
      }
      onChange([...additions.values()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'add_all_failed');
    } finally {
      setAddingAll(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterInput: React.CSSProperties = { width: 170 };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {/* Filter bar — mirrors the Clients list view. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input
          placeholder="Search name / ID / contact…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 210 }}
          aria-label="Search clients"
        />
        <div style={filterInput}>
          <Combobox
            ariaLabel="Owner"
            value={ownerId}
            onChange={(v) => setOwnerId(v ?? '')}
            options={[
              { value: '', label: 'Any owner' },
              ...owners.map((u) => ({ value: u.id, label: u.fullName })),
            ]}
          />
        </div>
        <div style={filterInput}>
          <Combobox
            ariaLabel="Client type"
            value={clientType}
            onChange={(v) => setClientType(v ?? '')}
            options={[
              { value: '', label: 'Any type' },
              { value: 'INDIVIDUAL', label: 'Individual' },
              { value: 'BUSINESS', label: 'Business' },
            ]}
          />
        </div>
        <div style={filterInput}>
          <Combobox
            ariaLabel="Entity type"
            value={entityType}
            onChange={(v) => setEntityType(v ?? '')}
            options={[{ value: '', label: 'Any entity' }, ...ENTITY_TYPE_OPTIONS]}
          />
        </div>
        {offices.length > 0 && (
          <div style={filterInput}>
            <Combobox
              ariaLabel="Office"
              value={officeId}
              onChange={(v) => setOfficeId(v ?? '')}
              options={[
                { value: '', label: 'Any office' },
                ...offices.map((o) => ({ value: o.id, label: o.name })),
              ]}
            />
          </div>
        )}
        <div style={filterInput}>
          <Combobox
            ariaLabel="Status"
            value={status}
            onChange={(v) => setStatus(v ?? '')}
            options={STATUS_OPTIONS}
          />
        </div>
      </div>

      {/* Selection toolbar. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Pill tone={selected.length > 0 ? 'accent' : 'neutral'}>{selected.length} selected</Pill>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void addAllMatching()}
          disabled={addingAll || total === 0}
        >
          {addingAll ? 'Adding…' : `Add all ${total} matching`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([])}
          disabled={selected.length === 0}
        >
          Clear selection
        </Button>
        {selected.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setReviewOpen((v) => !v)}>
            {reviewOpen ? 'Hide selected' : 'Review selected'}
          </Button>
        )}
        <span style={{ fontSize: 12, color: tokens.color.textMuted, marginLeft: 'auto' }}>
          {loading ? 'Loading…' : `${total} client${total === 1 ? '' : 's'} match`}
        </span>
      </div>

      {err && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>}

      {/* Review panel — removable chips for the current selection. */}
      {reviewOpen && selected.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            padding: 8,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            maxHeight: 180,
            overflowY: 'auto',
          }}
        >
          {selected.map((s) => (
            <span
              key={s.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 999,
                background: tokens.color.accentMuted,
                color: tokens.color.accent,
              }}
            >
              {s.name}
              <button
                type="button"
                aria-label={`Remove ${s.name}`}
                onClick={() => onChange(selected.filter((x) => x.id !== s.id))}
                style={{
                  background: 'transparent',
                  border: 0,
                  cursor: 'pointer',
                  color: 'inherit',
                  padding: 0,
                  fontSize: 12,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Results table (paged). */}
      <Table<ClientRow>
        columns={[
          {
            key: 'pick',
            header: (
              <input
                type="checkbox"
                checked={pageAllSelected}
                onChange={() => (pageAllSelected ? removePage() : addPage())}
                title="Select / clear this page"
                aria-label="Select all on this page"
              />
            ),
            render: (r) => (
              <input
                type="checkbox"
                checked={selectedIds.has(r.id)}
                onChange={() => toggle(r)}
                aria-label={`Select ${r.name}`}
              />
            ),
          },
          { key: 'name', header: 'Name', render: (r) => r.name },
          { key: 'ext', header: 'Client ID', render: (r) => r.externalId ?? '—' },
          { key: 'type', header: 'Type', render: (r) => <Pill>{r.clientType}</Pill> },
          {
            key: 'entity',
            header: 'Entity',
            render: (r) => (r.entityType ? ENTITY_TYPE_LABELS[r.entityType] : '—'),
          },
          { key: 'owner', header: 'Owner', render: (r) => r.partnerName ?? '—' },
          { key: 'office', header: 'Office', render: (r) => r.officeName ?? '—' },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        empty={loading ? 'Loading…' : 'No clients match these filters.'}
      />

      {/* Pager. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1 || loading}
        >
          ‹ Prev
        </Button>
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Page {page} of {totalPages}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages || loading}
        >
          Next ›
        </Button>
      </div>
    </div>
  );
}
