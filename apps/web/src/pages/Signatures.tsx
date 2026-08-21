// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Signatures list (P8). Firm-wide e-signature requests built on OpenSign:
// arbitrary PDFs with drag-placed fields and multiple signers. Lists
// requests with a status filter; "New request" opens the create dialog
// (title + form type + signers → a draft), then routes to the detail page
// where the PDF is uploaded, fields placed, and the request sent.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, ColumnFilter, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { usePermission } from '../auth-context';
import { TableSearch } from '../components/TableSearch';
import { selectRows, useColumnView } from '../lib/column-view';
import { useClientPage } from '../lib/use-paged-list';

interface RequestRow {
  id: string;
  title: string;
  status: string;
  clientId: string | null;
  clientName: string | null;
  formType: string | null;
  signerCount: number;
  signedCount: number;
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

// Status values for the Status column filter (excludes the proposals-only
// states the Signatures module never emits).
const STATUS_VALUES = [
  'draft',
  'sent',
  'partially_signed',
  'completed',
  'declined',
  'expired',
  'voided',
];

export function statusTone(s: string): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  switch (s) {
    case 'completed':
      return 'success';
    case 'sent':
      return 'accent';
    case 'partially_signed':
    case 'expired':
      return 'warning';
    case 'declined':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function statusLabel(s: string): string {
  return s
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

// Header cell: label + the shared ColumnFilter popover (sort + optional
// value filter), matching the other staff tables (Invoices, Filer, …).
function FilterHeader({
  label,
  col,
  view,
  values,
  searchable,
}: {
  label: string;
  col: string;
  view: ReturnType<typeof useColumnView>;
  values?: { value: string; label: string }[];
  searchable?: boolean;
}): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label}{' '}
      <ColumnFilter
        ariaLabel={values ? `Filter / sort ${label}` : `Sort by ${label}`}
        values={values ?? []}
        selected={values ? view.filterFor(col) : new Set()}
        searchable={searchable ?? Boolean(values)}
        sort={view.sortFor(col)}
        onApply={(sel, dir) => view.apply(col, values ? sel : new Set(), dir)}
      />
    </span>
  );
}

export function SignaturesPage(): JSX.Element {
  const navigate = useNavigate();
  const canWrite = usePermission('proposal:write');
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const view = useColumnView('vibe.signatures.view', { sortCol: '', sortDir: null });

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ requests: RequestRow[] }>('/api/staff/signatures');
      setRows(r.requests ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Distinct client / form values for those columns' filter dropdowns.
  const clientValues = useMemo(() => {
    const names = Array.from(new Set(rows.map((r) => r.clientName ?? '(no client)')));
    return names.sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }));
  }, [rows]);

  const formValues = useMemo(() => {
    const forms = Array.from(new Set(rows.map((r) => r.formType ?? 'Generic')));
    return forms.sort((a, b) => a.localeCompare(b)).map((f) => ({ value: f, label: f }));
  }, [rows]);

  const visible = useMemo(
    () =>
      selectRows(rows, view, {
        filters: {
          client: (r) => r.clientName ?? '(no client)',
          formType: (r) => r.formType ?? 'Generic',
          status: (r) => r.status,
        },
        sortValues: {
          title: (r) => r.title,
          client: (r) => r.clientName ?? '',
          formType: (r) => r.formType ?? '',
          status: (r) => r.status,
          signers: (r) => r.signedCount,
          sentAt: (r) => r.sentAt ?? '',
          expiresAt: (r) => r.expiresAt ?? '',
        },
        searchText: (r) => `${r.title} ${r.clientName ?? ''} ${r.formType ?? ''}`,
        tieBreak: (a, b) => b.createdAt.localeCompare(a.createdAt),
      }),
    [rows, view],
  );

  const { paged, pagination } = useClientPage(visible);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title={
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
            <span>Signatures</span>
            {rows.length > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {visible.length === rows.length
                  ? `${rows.length} request${rows.length === 1 ? '' : 's'}`
                  : `${visible.length} of ${rows.length}`}
              </span>
            )}
          </span>
        }
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {view.anyFilterActive && (
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
            )}
            {canWrite && <Button onClick={() => setCreateOpen(true)}>+ New request</Button>}
          </div>
        }
      >
        <div style={{ marginBottom: tokens.space.md, maxWidth: 360 }}>
          <TableSearch view={view} placeholder="Search title, client, form…" />
        </div>
        {loading ? (
          <div style={{ color: tokens.color.textMuted, fontSize: 13, padding: tokens.space.md }}>
            Loading…
          </div>
        ) : (
          <Table<RequestRow>
            columns={[
              {
                key: 'title',
                header: (
                  <FilterHeader label="Title" col="title" view={view} />
                ) as unknown as string,
                render: (r) => (
                  <a
                    href={`/signatures/${r.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/signatures/${r.id}`);
                    }}
                    style={{ color: tokens.color.accent, textDecoration: 'none' }}
                  >
                    {r.title}
                  </a>
                ),
              },
              {
                key: 'client',
                header: (
                  <FilterHeader label="Client" col="client" view={view} values={clientValues} />
                ) as unknown as string,
                render: (r) =>
                  r.clientName ?? <span style={{ color: tokens.color.textMuted }}>—</span>,
              },
              {
                key: 'formType',
                header: (
                  <FilterHeader label="Form" col="formType" view={view} values={formValues} />
                ) as unknown as string,
                render: (r) => r.formType ?? 'Generic',
              },
              {
                key: 'status',
                header: (
                  <FilterHeader
                    label="Status"
                    col="status"
                    view={view}
                    values={STATUS_VALUES.map((s) => ({ value: s, label: statusLabel(s) }))}
                    searchable={false}
                  />
                ) as unknown as string,
                render: (r) => <Pill tone={statusTone(r.status)}>{statusLabel(r.status)}</Pill>,
              },
              {
                key: 'signers',
                header: (
                  <FilterHeader label="Signed" col="signers" view={view} />
                ) as unknown as string,
                align: 'center',
                render: (r) => `${r.signedCount}/${r.signerCount}`,
              },
              {
                key: 'sentAt',
                header: (
                  <FilterHeader label="Sent" col="sentAt" view={view} />
                ) as unknown as string,
                render: (r) => (r.sentAt ? new Date(r.sentAt).toLocaleDateString() : '—'),
              },
              {
                key: 'expiresAt',
                header: (
                  <FilterHeader label="Expires" col="expiresAt" view={view} />
                ) as unknown as string,
                render: (r) => (r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : '—'),
              },
            ]}
            rows={paged}
            pagination={pagination}
            rowKey={(r) => r.id}
            empty={
              rows.length === 0
                ? 'No signature requests yet.'
                : 'No requests match the current filters.'
            }
          />
        )}
      </Card>

      {createOpen && (
        <CreateSignatureDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate(`/signatures/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ---- Create dialog ----------------------------------------------------

interface SignerDraft {
  name: string;
  email: string;
  role: string;
  // Set when the row was added from the client's people list (provenance,
  // sent to the API). `peopleKey` maps the row back to its people entry so the
  // checkbox can toggle it; manual rows leave all of these undefined.
  peopleKey?: string;
  personId?: string;
  clientContactId?: string;
  portalIdentityId?: string;
}

interface ClientHit {
  id: string;
  name: string;
}

interface EngagementHit {
  id: string;
  name: string;
  status: string;
}

// One reconciled person associated with a client (subset of the
// /clients/:id/people response we need to build a signer).
interface PersonEntry {
  key: string;
  name: string;
  email: string | null;
  hint: string;
  personId?: string;
  clientContactId?: string;
  portalIdentityId?: string;
}

interface PeopleApiEntry {
  key: string;
  kind: string;
  contact: {
    id: string;
    personId: string;
    fullName: string;
    email?: string | null;
    roleId?: string | null;
    isPrimary?: boolean;
  } | null;
  access: {
    id: string;
    portalIdentityId: string;
    fullName: string;
    primaryEmail?: string | null;
    role?: string | null;
  } | null;
  pendingInvitation: {
    proposedFullName: string;
    invitedEmail?: string | null;
  } | null;
}

const KIND_HINT: Record<string, string> = {
  linked: 'Contact + portal',
  contact_only: 'Contact',
  portal_only: 'Portal user',
  invited: 'Invited',
};

function toPersonEntry(e: PeopleApiEntry): PersonEntry | null {
  const name =
    e.contact?.fullName ?? e.access?.fullName ?? e.pendingInvitation?.proposedFullName ?? '';
  if (!name) return null;
  const email =
    e.contact?.email ?? e.access?.primaryEmail ?? e.pendingInvitation?.invitedEmail ?? null;
  const hint = e.contact?.isPrimary ? 'Primary contact' : (KIND_HINT[e.kind] ?? e.kind);
  return {
    key: e.key,
    name,
    email,
    hint,
    personId: e.contact?.personId,
    clientContactId: e.contact?.id,
    portalIdentityId: e.access?.portalIdentityId,
  };
}

const FORM_OPTIONS = [
  { value: '', label: 'Generic document' },
  { value: 'engagement-letter', label: 'Engagement letter' },
  { value: '8879-S', label: 'Form 8879-S (1120-S)' },
  { value: '8879-C', label: 'Form 8879-C (1120)' },
  { value: '8879-PE', label: 'Form 8879-PE (1065)' },
];

function CreateSignatureDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [formType, setFormType] = useState('');
  const [signers, setSigners] = useState<SignerDraft[]>([{ name: '', email: '', role: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 0221 — optional "start from a letter template": server renders the
  // template (client/engagement merge context) to PDF, attaches it as the
  // request source, and pre-places the engagement-letter profile fields.
  const [letterTemplates, setLetterTemplates] = useState<
    { id: string; name: string; status: string }[]
  >([]);
  const [letterTemplateId, setLetterTemplateId] = useState('');

  // Client + its associated people + engagements.
  const [clients, setClients] = useState<ClientHit[]>([]);
  const [clientId, setClientId] = useState('');
  const [people, setPeople] = useState<PersonEntry[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [engagements, setEngagements] = useState<EngagementHit[]>([]);
  const [engagementId, setEngagementId] = useState('');

  const valid = letterTemplateId
    ? Boolean(clientId) &&
      signers.length > 0 &&
      signers.every((s) => s.name.trim() && /.+@.+\..+/.test(s.email))
    : title.trim().length > 0 &&
      signers.length > 0 &&
      signers.every((s) => s.name.trim() && /.+@.+\..+/.test(s.email));

  function updateSigner(i: number, patch: Partial<SignerDraft>): void {
    setSigners((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  // Load the full client list once for the searchable dropdown. The list is
  // bounded for a single firm, so we fetch all (the Combobox filters locally)
  // rather than a server typeahead — matches the Requests/Invoices pickers.
  useEffect(() => {
    void api<{ rows?: ClientHit[]; items?: ClientHit[] }>('/api/staff/clients/picker')
      .then((r) => setClients(r.rows ?? r.items ?? []))
      .catch(() => undefined);
    void api<{ items: { id: string; name: string; status: string }[] }>(
      '/api/staff/admin/templates/letter',
    )
      .then((r) => setLetterTemplates((r.items ?? []).filter((t) => t.status === 'ACTIVE')))
      .catch(() => setLetterTemplates([]));
  }, []);

  // When the selected client changes, reset client-scoped state and (if a
  // client was picked) load its people + engagements.
  function onClientChange(id: string): void {
    setClientId(id);
    setEngagementId('');
    setEngagements([]);
    setPeople([]);
    // Drop people-derived signers; keep manual ones.
    setSigners((prev) => {
      const manual = prev.filter((s) => !s.peopleKey);
      return manual.length ? manual : [{ name: '', email: '', role: '' }];
    });
    if (!id) return;
    setPeopleLoading(true);
    void Promise.all([
      api<{ items?: PeopleApiEntry[]; people?: PeopleApiEntry[] }>(
        `/api/staff/clients/${id}/people`,
      ).catch(() => ({}) as { items?: PeopleApiEntry[]; people?: PeopleApiEntry[] }),
      api<{ items: EngagementHit[] }>(`/api/staff/engagements?clientId=${id}&pageSize=100`).catch(
        () => ({ items: [] }),
      ),
    ])
      .then(([pr, er]) => {
        const raw = pr.items ?? pr.people ?? [];
        const entries = raw.map(toPersonEntry).filter((x): x is PersonEntry => x !== null);
        // De-dupe by display key.
        const seen = new Set<string>();
        setPeople(entries.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true))));
        setEngagements(er.items ?? []);
      })
      .finally(() => setPeopleLoading(false));
  }

  function togglePerson(p: PersonEntry, checked: boolean): void {
    setSigners((prev) => {
      if (checked) {
        if (prev.some((s) => s.peopleKey === p.key)) return prev;
        const next = prev.filter(
          // Drop a leading blank manual row so the first pick isn't paired with an empty one.
          (s, idx) => !(idx === 0 && !s.peopleKey && !s.name && !s.email && prev.length === 1),
        );
        return [
          ...next,
          {
            name: p.name,
            email: p.email ?? '',
            role: '',
            peopleKey: p.key,
            personId: p.personId,
            clientContactId: p.clientContactId,
            portalIdentityId: p.portalIdentityId,
          },
        ];
      }
      const after = prev.filter((s) => s.peopleKey !== p.key);
      return after.length ? after : [{ name: '', email: '', role: '' }];
    });
  }

  const selectedKeys = new Set(signers.map((s) => s.peopleKey).filter(Boolean) as string[]);

  async function submit(): Promise<void> {
    if (!valid) {
      setError('A title and at least one signer (name + email) are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const signerPayload = signers.map((s) => ({
        name: s.name.trim(),
        email: s.email.trim(),
        role: s.role.trim() || undefined,
        personId: s.personId,
        clientContactId: s.clientContactId,
        portalIdentityId: s.portalIdentityId,
      }));
      const created = letterTemplateId
        ? await api<{ id: string }>('/api/staff/signatures/from-letter-template', {
            method: 'POST',
            body: JSON.stringify({
              letterTemplateId,
              clientId,
              engagementId: engagementId || undefined,
              title: title.trim() || undefined,
              signers: signerPayload,
            }),
          })
        : await api<{ id: string }>('/api/staff/signatures', {
            method: 'POST',
            body: JSON.stringify({
              title: title.trim(),
              formType: formType || undefined,
              clientId: clientId || undefined,
              engagementId: engagementId || undefined,
              signers: signerPayload,
            }),
          });
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create_failed');
    } finally {
      setBusy(false);
    }
  }

  const clientOptions = [
    { value: '', label: '— No client —' },
    ...clients.map((c) => ({ value: c.id, label: c.name })),
  ];

  const engagementOptions = [
    { value: '', label: '— No engagement —' },
    ...engagements.map((e) => ({ value: e.id, label: `${e.name} (${statusLabel(e.status)})` })),
  ];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: tokens.space.xl,
      }}
    >
      <div style={{ maxWidth: 820, width: '100%', maxHeight: '90vh', overflow: 'auto' }}>
        <Card title="New signature request">
          <div style={{ display: 'grid', gap: tokens.space.md }}>
            <Input
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="8879-S — Acme Inc 2025"
            />
            <div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Form type
              </div>
              <Combobox
                options={FORM_OPTIONS}
                value={formType}
                onChange={setFormType}
                ariaLabel="Form type"
              />
            </div>

            {letterTemplates.length > 0 && (
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Start from a letter template (optional)
                </div>
                <Combobox
                  ariaLabel="Letter template"
                  clearable
                  options={[
                    { value: '', label: '— Blank (upload a PDF later) —' },
                    ...letterTemplates.map((t) => ({ value: t.id, label: t.name })),
                  ]}
                  value={letterTemplateId}
                  onChange={setLetterTemplateId}
                />
                {letterTemplateId && (
                  <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '4px 0 0' }}>
                    The letter is rendered for the selected client (client required; engagement
                    fills its merge tokens), attached as the PDF, and client signature + date fields
                    are pre-placed on the last page — adjust them in the editor before sending.
                    Signers with no role are treated as &ldquo;client&rdquo;.
                  </p>
                )}
              </div>
            )}

            {/* Client picker */}
            <div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Client (optional — pull signers from the client&apos;s people)
              </div>
              <Combobox
                options={clientOptions}
                value={clientId}
                onChange={onClientChange}
                placeholder="Select a client…"
                ariaLabel="Client"
                clearable
              />
            </div>

            {/* People → signers */}
            {clientId && (
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  People on this client
                </div>
                {peopleLoading ? (
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>Loading…</div>
                ) : people.length === 0 ? (
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    No associated people found — add signers manually below.
                  </div>
                ) : (
                  <div
                    style={{
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.md,
                      maxHeight: 180,
                      overflowY: 'auto',
                    }}
                  >
                    {people.map((p) => {
                      const noEmail = !p.email;
                      return (
                        <label
                          key={p.key}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 10px',
                            fontSize: 13,
                            opacity: noEmail ? 0.5 : 1,
                            cursor: noEmail ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            disabled={noEmail}
                            checked={selectedKeys.has(p.key)}
                            onChange={(e) => togglePerson(p, e.target.checked)}
                          />
                          <span style={{ flex: 1 }}>
                            {p.name}
                            {p.email ? (
                              <span style={{ color: tokens.color.textMuted }}> · {p.email}</span>
                            ) : (
                              <span style={{ color: tokens.color.danger }}>
                                {' '}
                                · no email on file
                              </span>
                            )}
                          </span>
                          <Pill>{p.hint}</Pill>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Engagement picker */}
            {clientId && (
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Engagement (optional)
                </div>
                <Combobox
                  options={engagementOptions}
                  value={engagementId}
                  onChange={setEngagementId}
                  ariaLabel="Engagement"
                />
              </div>
            )}

            <div style={{ fontSize: 13, fontWeight: 600, color: tokens.color.text }}>Signers</div>
            {signers.map((s, i) => (
              <div
                key={s.peopleKey ?? `manual-${i}`}
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 0.8fr auto', gap: 8 }}
              >
                <Input
                  label={i === 0 ? 'Name' : undefined}
                  value={s.name}
                  onChange={(e) => updateSigner(i, { name: e.target.value })}
                  placeholder="Pat Officer"
                />
                <Input
                  label={i === 0 ? 'Email' : undefined}
                  value={s.email}
                  onChange={(e) => updateSigner(i, { email: e.target.value })}
                  placeholder="pat@co.example"
                />
                <Input
                  label={i === 0 ? 'Role' : undefined}
                  value={s.role}
                  onChange={(e) => updateSigner(i, { role: e.target.value })}
                  placeholder="officer"
                />
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <Button
                    variant="ghost"
                    onClick={() => setSigners((p) => p.filter((_, idx) => idx !== i))}
                    disabled={signers.length === 1}
                  >
                    ✕
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                onClick={() => setSigners((p) => [...p, { name: '', email: '', role: '' }])}
              >
                + Add signer
              </Button>
            </div>

            {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={!valid || busy}>
                {busy ? 'Creating…' : 'Create draft'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
