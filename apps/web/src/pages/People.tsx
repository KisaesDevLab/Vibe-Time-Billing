// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm-wide People directory (0115 follow-up). One table of every human in
// the firm — directory contacts plus standalone portal logins — with a
// Portal column showing whether they have any active portal access. Click
// through to a person to edit them and manage their per-client portal
// access.
//
// Standard table view: loads the full firm set once, then filter / sort /
// search run client-side via useColumnView + ColumnFilter headers +
// TableSearch (see apps/web/src/lib/column-view.ts). Backed by
// GET /api/staff/people.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MailX, MessageSquareOff, PhoneOff } from 'lucide-react';

import { Button, Card, ColumnFilter, Combobox, Input, Modal, Pill, Table, tokens } from '@vibe/ui';
import { RichTextEditor } from '../proposal-editor/RichTextEditor';

import { api } from '../api-client';
import { usePermission } from '../auth-context';
import { TableSearch } from '../components/TableSearch';
import { useColumnView, viewToPagedQuery } from '../lib/column-view';
import { usePagedList } from '../lib/use-paged-list';

interface PersonRow {
  key: string;
  kind: 'person' | 'portal_identity';
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  status: string;
  hasPortalAccess: boolean;
  portalStatus: 'yes' | 'invited' | 'no';
  clientCount: number;
  bulkEmailOptOut: boolean;
  // 0224 — channel blocks shown as an icon next to the handle.
  smsOptOut: boolean;
  doNotCall: boolean;
}

/** Small "blocked" marker next to a contact handle. */
function Blocked({ title, kind }: { title: string; kind: 'email' | 'sms' | 'call' }): JSX.Element {
  const Icon = kind === 'email' ? MailX : kind === 'sms' ? MessageSquareOff : PhoneOff;
  return (
    <span
      title={title}
      aria-label={title}
      style={{ display: 'inline-flex', color: tokens.color.danger, lineHeight: 0 }}
    >
      <Icon size={13} />
    </span>
  );
}

const PORTAL_VALUES = [
  { value: 'yes', label: 'Enabled' },
  { value: 'invited', label: 'Invite pending' },
  { value: 'no', label: 'None' },
];
const KIND_VALUES = [
  { value: 'person', label: 'Directory contact' },
  { value: 'portal_identity', label: 'Portal-only' },
];
// 0221 — presence filters for the email/phone columns.
const PRESENCE_VALUES = [
  { value: 'not_blank', label: '(not blank)' },
  { value: 'blank', label: '(blank)' },
];

export function PeopleDirectoryPage(): JSX.Element {
  const navigate = useNavigate();
  const [viewAsBusy, setViewAsBusy] = useState<string | null>(null);
  // Mirrors the impersonate endpoint's gate (engagement:read).
  const canViewAs = usePermission('engagement:read');

  // Filter/sort/search state (sessionStorage-persisted); filtering, sorting,
  // and paging run SERVER-side. `.v2` drops stale pre-migration state.
  const view = useColumnView('vibe.people.view.v2', { sortCol: 'name', sortDir: 'asc' });
  const query = useMemo(
    () =>
      viewToPagedQuery(view, {
        filterMap: {
          portal: 'portal',
          kind: 'kind',
          email: 'email',
          phone: 'phone',
          mobile: 'mobile',
        },
      }),
    [view],
  );
  const list = usePagedList<PersonRow>('/api/staff/people', { query });
  const loading = list.loading;

  // 0221 — bulk selection + bulk portal invite.
  const canInvite = usePermission('client:portal-access:manage');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState<'FULL' | 'VIEW_ONLY' | 'PAY_ONLY'>('FULL');
  const [bulkChannel, setBulkChannel] = useState<'EMAIL' | 'SMS' | 'BOTH'>('EMAIL');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  // 0221 — bulk email compose dialog.
  const [emailOpen, setEmailOpen] = useState(false);
  // 0221 — merge duplicates dialog (persons only).
  const [mergeOpen, setMergeOpen] = useState(false);
  const selectedPersonKeys = Array.from(selected).filter((k) => k.startsWith('p:'));

  const pageKeys = list.rows.map((r) => r.key);
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const somePageSelected = pageKeys.some((k) => selected.has(k));

  function toggleSelectAll(): void {
    setSelected((prev) => {
      if (allPageSelected) {
        const next = new Set(prev);
        for (const k of pageKeys) next.delete(k);
        return next;
      }
      return new Set([...prev, ...pageKeys]);
    });
  }

  async function bulkInvite(): Promise<void> {
    // Selection keys are `p:<id>` / `i:<id>`; rebuild kind+id for the API.
    const people = Array.from(selected).map((k) => ({
      kind: k.startsWith('i:') ? ('portal_identity' as const) : ('person' as const),
      id: k.slice(2),
    }));
    if (people.length === 0) return;
    setBulkBusy(true);
    setBulkNotice(null);
    try {
      const r = await api<{
        results: { status: string; reason?: string; fullName: string | null }[];
      }>('/api/staff/portal-invites/bulk-people', {
        method: 'POST',
        body: JSON.stringify({ people, role: bulkRole, channel: bulkChannel }),
      });
      const count = (s: string): number => r.results.filter((x) => x.status === s).length;
      const skipped = r.results.filter((x) => x.status === 'skipped');
      const parts = [
        count('invited') > 0 ? `${count('invited')} invited` : null,
        count('granted') > 0 ? `${count('granted')} granted access (already had a login)` : null,
        skipped.length > 0
          ? `${skipped.length} skipped (${[...new Set(skipped.map((x) => x.reason))].join(', ')})`
          : null,
        count('failed') > 0 ? `${count('failed')} failed` : null,
      ].filter(Boolean);
      setBulkNotice(`Portal invites: ${parts.join(' · ')}.`);
      setSelected(new Set());
      list.reload();
    } catch (e) {
      setBulkNotice(
        e instanceof Error ? `Bulk invite failed: ${e.message}` : 'Bulk invite failed.',
      );
    } finally {
      setBulkBusy(false);
    }
  }

  // The list row doesn't carry access ids, so resolve them on demand:
  // exactly one ACTIVE access → open the portal directly; several →
  // land on the person page where each client has its own button.
  async function viewAs(p: PersonRow): Promise<void> {
    setViewAsBusy(p.key);
    try {
      const detail = await api<{
        clients: Array<{ clientId: string; accessId: string | null; accessStatus: string | null }>;
      }>(`/api/staff/people/${p.id}`);
      const active = (detail.clients ?? []).filter(
        (c) => c.accessStatus === 'ACTIVE' && c.accessId,
      );
      if (active.length === 1) {
        const r = await api<{ portalUrl: string }>(
          `/api/staff/clients/${active[0]!.clientId}/impersonate`,
          { method: 'POST', body: JSON.stringify({ accessId: active[0]!.accessId }) },
        );
        window.open(r.portalUrl, '_blank', 'noopener,noreferrer');
      } else {
        navigate(`/people/${p.id}`);
      }
    } catch {
      navigate(`/people/${p.id}`);
    } finally {
      setViewAsBusy(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>People</span>
            {list.total > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {view.anyFilterActive
                  ? `${list.total} match${list.total === 1 ? '' : 'es'}`
                  : `${list.total} ${list.total === 1 ? 'person' : 'people'}`}
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
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={view} placeholder="Search by name, email or phone…" />
        </div>
        {bulkNotice && (
          <p style={{ fontSize: 13, color: tokens.color.text, marginTop: 0 }}>{bulkNotice}</p>
        )}
        {selected.size > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              marginBottom: 10,
              padding: '6px 10px',
              borderRadius: tokens.radius.sm,
              background: tokens.color.accentMuted,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>{selected.size} selected</span>
            <div style={{ width: 140 }}>
              <Combobox
                ariaLabel="Portal role for bulk invite"
                value={bulkRole}
                onChange={(v) => setBulkRole(v as typeof bulkRole)}
                size="sm"
                options={[
                  { value: 'FULL', label: 'Full access' },
                  { value: 'VIEW_ONLY', label: 'View only' },
                  { value: 'PAY_ONLY', label: 'Pay only' },
                ]}
              />
            </div>
            <div style={{ width: 150 }}>
              <Combobox
                ariaLabel="Delivery channel for bulk invite"
                value={bulkChannel}
                onChange={(v) => setBulkChannel(v as typeof bulkChannel)}
                size="sm"
                options={[
                  { value: 'EMAIL', label: 'Email' },
                  { value: 'SMS', label: 'Text (SMS)' },
                  { value: 'BOTH', label: 'Email + text' },
                ]}
              />
            </div>
            <Button
              size="sm"
              disabled={bulkBusy || !canInvite}
              title={!canInvite ? 'Needs client:portal-access:manage' : undefined}
              onClick={() => void bulkInvite()}
            >
              {bulkBusy ? 'Inviting…' : `Invite ${selected.size} to portal`}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEmailOpen(true)}>
              Email {selected.size}…
            </Button>
            {selected.size >= 2 && selectedPersonKeys.length >= 1 && (
              <Button size="sm" variant="secondary" onClick={() => setMergeOpen(true)}>
                Merge {selected.size}…
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<PersonRow>
            columns={[
              {
                key: 'sel',
                header: (
                  <input
                    type="checkbox"
                    aria-label="Select all people on this page"
                    checked={allPageSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = somePageSelected && !allPageSelected;
                    }}
                    disabled={pageKeys.length === 0}
                    onChange={toggleSelectAll}
                  />
                ) as unknown as string,
                render: (p) => (
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.fullName}`}
                    checked={selected.has(p.key)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.key)) next.delete(p.key);
                        else next.add(p.key);
                        return next;
                      })
                    }
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
                render: (p) => (
                  <a
                    href={`/people/${p.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/people/${p.id}`);
                    }}
                  >
                    {p.fullName}
                  </a>
                ),
              },
              {
                key: 'email',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Email{' '}
                    <ColumnFilter
                      ariaLabel="Filter or sort by email"
                      values={PRESENCE_VALUES}
                      selected={view.filterFor('email')}
                      searchable={false}
                      sort={view.sortFor('email')}
                      onApply={(sel, dir) => view.apply('email', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (p) => (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    {p.email ?? '—'}
                    {p.bulkEmailOptOut && <Blocked kind="email" title="Blocked from bulk email" />}
                  </span>
                ),
              },
              {
                key: 'phone',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Phone{' '}
                    <ColumnFilter
                      ariaLabel="Filter or sort by phone"
                      values={PRESENCE_VALUES}
                      selected={view.filterFor('phone')}
                      searchable={false}
                      sort={view.sortFor('phone')}
                      onApply={(sel, dir) => view.apply('phone', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (p) => (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    {p.phone ?? '—'}
                    {p.phone && p.doNotCall && (
                      <Blocked kind="call" title="Do not call (automated calls blocked)" />
                    )}
                    {/* Texts go to the landline when there is no mobile. */}
                    {p.phone && !p.mobile && p.smsOptOut && (
                      <Blocked kind="sms" title="Text messages blocked" />
                    )}
                  </span>
                ),
              },
              {
                key: 'mobile',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Mobile{' '}
                    <ColumnFilter
                      ariaLabel="Filter or sort by mobile"
                      values={PRESENCE_VALUES}
                      selected={view.filterFor('mobile')}
                      searchable={false}
                      sort={view.sortFor('mobile')}
                      onApply={(sel, dir) => view.apply('mobile', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (p) => (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    {p.mobile ?? '—'}
                    {p.mobile && p.smsOptOut && (
                      <Blocked kind="sms" title="Text messages blocked" />
                    )}
                    {p.mobile && p.doNotCall && (
                      <Blocked kind="call" title="Do not call (automated calls blocked)" />
                    )}
                  </span>
                ),
              },
              {
                key: 'clients',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Clients{' '}
                    <ColumnFilter
                      ariaLabel="Sort by client count"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('clients')}
                      onApply={(_, dir) => view.apply('clients', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                align: 'right',
                render: (p) => p.clientCount,
              },
              {
                key: 'portal',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Portal{' '}
                    <ColumnFilter
                      ariaLabel="Filter by portal access"
                      values={PORTAL_VALUES}
                      selected={view.filterFor('portal')}
                      searchable={false}
                      sort={null}
                      onApply={(sel) => view.apply('portal', sel, view.sortFor('portal'))}
                    />
                  </span>
                ) as unknown as string,
                render: (p) =>
                  p.portalStatus === 'invited' ? (
                    <Pill tone="warning">Invited</Pill>
                  ) : p.hasPortalAccess ? (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <Pill tone="success">Enabled</Pill>
                      {canViewAs && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={viewAsBusy === p.key}
                          title="Open the portal as this person (read-only impersonation, 5-min token)"
                          onClick={() => void viewAs(p)}
                        >
                          {viewAsBusy === p.key ? 'Opening…' : 'View as'}
                        </Button>
                      )}
                    </span>
                  ) : (
                    <Pill tone="neutral">—</Pill>
                  ),
              },
              {
                key: 'kind',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Kind{' '}
                    <ColumnFilter
                      ariaLabel="Filter by kind"
                      values={KIND_VALUES}
                      selected={view.filterFor('kind')}
                      searchable={false}
                      sort={null}
                      onApply={(sel) => view.apply('kind', sel, view.sortFor('kind'))}
                    />
                  </span>
                ) as unknown as string,
                render: (p) =>
                  p.kind === 'portal_identity' ? <Pill tone="warning">Portal-only</Pill> : null,
              },
            ]}
            rows={list.rows}
            pagination={{ ...list.pagination, pageSizeOptions: [25, 50, 100, 500, 1000, 100_000] }}
            rowKey={(p) => p.key}
            empty="No people match the current filters."
          />
        )}
        {mergeOpen && (
          <MergePeopleDialog
            people={list.rows.filter((r) => selected.has(r.key))}
            onClose={() => setMergeOpen(false)}
            onMerged={(msg) => {
              setMergeOpen(false);
              setBulkNotice(msg);
              setSelected(new Set());
              list.reload();
            }}
          />
        )}
        {emailOpen && (
          <BulkEmailPeopleDialog
            selectedKeys={Array.from(selected)}
            onClose={() => setEmailOpen(false)}
            onSent={(msg) => {
              setEmailOpen(false);
              setBulkNotice(msg);
              setSelected(new Set());
            }}
          />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 0221 — bulk email compose. Markdown body with {{firm.*}} + {{person.name}}
// tokens; the server skips blank emails and opted-out people and reports
// per-person results.
// ---------------------------------------------------------------------------

function BulkEmailPeopleDialog({
  selectedKeys,
  onClose,
  onSent,
}: {
  selectedKeys: string[];
  onClose: () => void;
  onSent: (summary: string) => void;
}): JSX.Element {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(): Promise<void> {
    if (!subject.trim() || !body.trim()) {
      setError('Subject and body are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const people = selectedKeys.map((k) => ({
        kind: k.startsWith('i:') ? ('portal_identity' as const) : ('person' as const),
        id: k.slice(2),
      }));
      const r = await api<{
        results: { sent: boolean; reason: string | null }[];
      }>('/api/staff/people/bulk-email', {
        method: 'POST',
        body: JSON.stringify({ people, subject: subject.trim(), body: body.trim() }),
      });
      const sent = r.results.filter((x) => x.sent).length;
      const optedOut = r.results.filter((x) => x.reason === 'opted_out').length;
      const noEmail = r.results.filter((x) => x.reason === 'no_email').length;
      const failed = r.results.filter(
        (x) => !x.sent && x.reason !== 'opted_out' && x.reason !== 'no_email',
      ).length;
      onSent(
        `Bulk email: ${sent} sent` +
          (optedOut ? ` · ${optedOut} opted out` : '') +
          (noEmail ? ` · ${noEmail} without an email` : '') +
          (failed ? ` · ${failed} failed` : '') +
          '.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'send_failed');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Email ${selectedKeys.length} people`}
      onClose={busy ? undefined : onClose}
      maxWidth={640}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <Input
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. Office closed Friday — {{firm.name}}"
          disabled={busy}
        />
        <div>
          <span
            style={{
              fontSize: 12,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Body — Markdown; tokens: {'{{person.name}}'}, {'{{firm.name}}'}
          </span>
          <RichTextEditor value={body} onChange={setBody} minHeight={200} />
        </div>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          People without an email or who opted out of bulk email are skipped automatically.
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void send()} disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 0221 — merge duplicate people. Pick the surviving record; every client
// contact, portal login, signature, booking, and call log repoints to it,
// and the duplicates are archived (their email backfills the survivor's
// blank fields). Portal-only rows can't merge — link them to a person first.
// ---------------------------------------------------------------------------

function MergePeopleDialog({
  people,
  onClose,
  onMerged,
}: {
  people: PersonRow[];
  onClose: () => void;
  onMerged: (summary: string) => void;
}): JSX.Element {
  const personRows = people.filter((p) => p.kind === 'person');
  const identityRows = people.filter((p) => p.kind === 'portal_identity');
  const [survivorKey, setSurvivorKey] = useState(personRows[0]?.key ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge(): Promise<void> {
    const survivor = people.find((p) => p.key === survivorKey);
    if (!survivor) return;
    const mergeIds = people.filter((p) => p.key !== survivorKey).map((p) => p.id);
    setBusy(true);
    setError(null);
    try {
      await api('/api/staff/people/merge', {
        method: 'POST',
        body: JSON.stringify({ survivorId: survivor.id, mergeIds }),
      });
      onMerged(
        `Merged ${mergeIds.length} ${mergeIds.length === 1 ? 'person' : 'people'} into ${survivor.fullName}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'merge_failed');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Merge ${people.length} people`}
      onClose={busy ? undefined : onClose}
      maxWidth={560}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ fontSize: 13, margin: 0 }}>
          Pick the record to KEEP. The others are archived, and everything that referenced them —
          client contacts, portal logins, signatures, appointments, call logs — moves to the kept
          record. Blank email/phone on the kept record backfill from the merged ones.
        </p>
        <div style={{ display: 'grid', gap: 6 }}>
          {personRows.map((p) => (
            <label
              key={p.key}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                padding: '8px 10px',
                border: `1px solid ${survivorKey === p.key ? tokens.color.accent : tokens.color.border}`,
                borderRadius: tokens.radius.md,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <input
                type="radio"
                name="merge-survivor"
                checked={survivorKey === p.key}
                onChange={() => setSurvivorKey(p.key)}
              />
              <span style={{ flex: 1 }}>
                <strong>{p.fullName}</strong>
                <span style={{ color: tokens.color.textMuted, marginLeft: 8 }}>
                  {p.email ?? 'no email'} · {p.phone ?? 'no phone'} · {p.clientCount} client
                  {p.clientCount === 1 ? '' : 's'}
                </span>
              </span>
              {survivorKey === p.key && <Pill tone="success">keep</Pill>}
            </label>
          ))}
          {identityRows.map((p) => (
            <div
              key={p.key}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                padding: '8px 10px',
                border: `1px dashed ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 13,
                color: tokens.color.textMuted,
              }}
            >
              <span style={{ flex: 1 }}>
                <strong style={{ color: tokens.color.text }}>{p.fullName}</strong>
                <span style={{ marginLeft: 8 }}>{p.email ?? 'no email'}</span>
              </span>
              <Pill tone="warning">portal login — will be linked</Pill>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: tokens.color.warning, margin: 0 }}>
          This cannot be undone from the UI. Archived duplicates keep their history but disappear
          from pickers.
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void merge()} disabled={busy || !survivorKey}>
            {busy ? 'Merging…' : 'Merge'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
