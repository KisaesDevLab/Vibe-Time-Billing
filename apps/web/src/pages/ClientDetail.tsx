// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';

import { Button, Card, Input, Pill, Table, Tabs, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { PrintButton } from '../components/PrintButton';
import { BillingCard } from './clients/BillingCard';
import { ClientInfoCard } from './clients/ClientInfoCard';
import { PeopleCard } from './clients/PeopleCard';
import { TaxPaymentsCard } from './clients/TaxPaymentsCard';
import { ClientCredentialsCard } from './clients/ClientCredentialsCard';
import { usePermission } from '../auth-context';
import { useTimersOptional } from '../timer-context';
import { ClientMessagesCard } from './messaging/ClientMessagesCard';
import { ClientSmsCard } from './sms/ClientSmsCard';
import { CommunicationsCard } from './clients/CommunicationsCard';
// File manager v1 removed; v2 (B2-backed, addendum) lands in Phase 10.
import { ClientFilesTab } from './clients/ClientFilesTab';
import { ClientRequestsCard } from './clients/ClientRequestsCard';
import { ClientTaxReturnsCard } from './clients/ClientTaxReturnsCard';
import { NotesCard } from './clients/NotesCard';
import { RecurringEngagementsCard } from './clients/RecurringEngagementsCard';
import { TasksCard } from './clients/TasksCard';

interface Client {
  id: string;
  name: string;
  status: string;
  termsDays: number;
  invoiceConsolidationPreference: 'CONSOLIDATED' | 'SEPARATE';
  partnerInChargeId: string | null;
  partnerName?: string | null;
  createdAt: string;
  tags?: string[] | null;
  customFields?: Record<string, unknown> | null;
  // v2 Sprint B (0026)
  clientType?: 'INDIVIDUAL' | 'BUSINESS';
  clientFacingName?: string | null;
  externalId?: string | null;
  filingStatus?: 'SINGLE' | 'MFJ' | 'MFS' | 'HOH' | 'QW' | null;
  pipelineStage?: 'PROSPECT' | 'CLIENT' | 'OTHER';
  active?: boolean;
  // 0165 — per-client visibility restriction.
  restricted?: boolean;
  accessRestricted?: boolean;
  canManageRestriction?: boolean;
  designatedUserIds?: string[];
}

interface ClientLite {
  id: string;
  name: string;
  status: string;
}

interface Engagement {
  id: string;
  name: string;
  status: string;
  feeStructure: string;
  feeAmountCents: number | null;
  // Server-side correlated count of time entries with billing_batch_id
  // IS NULL — drives the "Bill →" button visibility so we don't offer
  // a workflow that has nothing to bill.
  unbilledEntryCount?: number;
}

interface Summary {
  clientId: string;
  engagementCount: number;
  activeEngagementCount: number;
  invoiceCount: number;
  invoicedCents: number;
  paidCents: number;
  outstandingCents: number;
  wipHours: number;
  wipAmountCents: number;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

type Tab =
  | 'home'
  | 'communications'
  | 'messages'
  | 'sms'
  | 'requests'
  | 'notes'
  | 'files'
  | 'tasks'
  | 'engagements'
  | 'appointments'
  | 'billing'
  | 'tax'
  | 'credentials';

interface StaffUser {
  id: string;
  fullName: string;
}

export function ClientDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<Client | null>(null);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  const [allClients, setAllClients] = useState<ClientLite[]>([]);
  const [tab, setTab] = useState<Tab>('home');
  const canViewCredentials = usePermission('client:credential:read');
  // 0234 — SMS inbox rides on messaging:read until Phase 11 adds sms:*.
  const canSms = usePermission('messaging:read');
  // 0207 — header "▶ Timer" context-aware start (client pre-filled).
  const timers = useTimersOptional();
  const [staff, setStaff] = useState<StaffUser[]>([]);

  // 0165 — if the client is restricted for this caller, the only visible
  // tabs are Home + Billing; snap back to Home if a now-hidden tab is active.
  const restrictedView = Boolean(client?.accessRestricted);
  useEffect(() => {
    if (restrictedView && tab !== 'home' && tab !== 'billing') setTab('home');
  }, [restrictedView, tab]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ users: StaffUser[] }>('/api/staff/admin/users');
        setStaff(r.users ?? []);
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  async function load(): Promise<void> {
    if (!id) return;
    try {
      const [c, e, s] = await Promise.all([
        api<{ client: Client }>(`/api/staff/clients/${id}`),
        api<{ items: Engagement[] }>(`/api/staff/engagements?clientId=${id}`),
        api<{ summary: Summary | null }>(`/api/staff/stats/client/${id}`),
      ]);
      setClient(c.client);
      setEngagements(e.items ?? []);
      setSummary(s.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function openMerge(): Promise<void> {
    setShowMerge(true);
    if (allClients.length === 0) {
      try {
        const r = await api<{ items: ClientLite[] }>('/api/staff/clients/picker');
        setAllClients(r.items ?? []);
      } catch {
        // ignore — dialog still renders with empty list
      }
    }
  }

  if (error) {
    return (
      <Card title="Error">
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }
  if (!client) {
    return (
      <Card title="Client">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title={
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span>{client.clientFacingName || client.name}</span>
            {client.clientType && (
              <Pill>{client.clientType === 'INDIVIDUAL' ? 'Individual' : 'Business'}</Pill>
            )}
            {client.pipelineStage && client.pipelineStage !== 'CLIENT' && (
              <Pill tone={client.pipelineStage === 'PROSPECT' ? 'warning' : 'neutral'}>
                {client.pipelineStage[0] + client.pipelineStage.slice(1).toLowerCase()}
              </Pill>
            )}
          </span>
        }
        action={
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {timers?.canUse && (
              <Button
                size="sm"
                variant="ghost"
                title="Start a stopwatch for this client (auto-picks the engagement when there's exactly one active)"
                onClick={() => {
                  const active = engagements.filter((e) => e.status === 'ACTIVE');
                  void timers.startTimer({
                    clientId: client.id,
                    engagementId: active.length === 1 ? active[0]!.id : undefined,
                  });
                }}
              >
                ▶ Timer
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                window.location.href = `/engagements/new?clientId=${client.id}`;
              }}
              title="Start a new engagement scoped to this client"
            >
              + Engagement
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTab('tasks')}
              title="Open the Tasks tab to add a task"
            >
              + Task
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTab('communications')}
              title="Open the Communications tab to log an email/call"
            >
              ✉ Log email
            </Button>
            {/* Direct-print the client's mailing address to a Vibe Print
                gateway printer. Both self-hide when the gateway is off. */}
            <PrintButton
              endpoint={`/api/staff/clients/${client.id}/print-envelope`}
              label="✉ Envelope"
            />
            <PrintButton
              endpoint={`/api/staff/clients/${client.id}/print-label`}
              label="🏷 Label"
            />
            {client.active === false && <Pill tone="warning">Inactive</Pill>}
            {client.accessRestricted && <Pill tone="warning">Restricted — limited access</Pill>}
            {client.restricted && !client.accessRestricted && (
              <Pill tone="warning">Restricted</Pill>
            )}
            <Pill tone={client.status === 'ACTIVE' ? 'success' : 'neutral'}>{client.status}</Pill>
          </span>
        }
      >
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto 1fr',
            gap: '6px 16px',
            fontSize: 13,
            margin: 0,
          }}
        >
          <dt style={{ color: tokens.color.textMuted }}>Terms</dt>
          <dd style={{ margin: 0 }}>{client.termsDays} days</dd>
          {/* All-time figure (from /stats/client) — the Billing tab's
              Outstanding defaults to the current year, so label the scope
              here to keep the two from looking contradictory. */}
          <dt style={{ color: tokens.color.textMuted }}>Outstanding (all time)</dt>
          <dd style={{ margin: 0 }}>{summary ? formatCents(summary.outstandingCents) : '—'}</dd>
          {client.externalId && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>External ID</dt>
              <dd style={{ margin: 0 }}>{client.externalId}</dd>
            </>
          )}
          {client.filingStatus && (
            <>
              <dt style={{ color: tokens.color.textMuted }}>Filing status</dt>
              <dd style={{ margin: 0 }}>{client.filingStatus}</dd>
            </>
          )}
          <dt style={{ color: tokens.color.textMuted }}>Created</dt>
          <dd style={{ margin: 0 }}>{client.createdAt.slice(0, 10)}</dd>
        </dl>
      </Card>

      <Tabs
        tabs={[
          { key: 'home', label: 'Home' },
          // 0165 — when the client is restricted and the caller isn't
          // authorized, only the basic surfaces (Home + Billing/A-R) show.
          ...(client.accessRestricted
            ? []
            : [
                { key: 'messages', label: 'Messages' },
                ...(canSms ? [{ key: 'sms', label: 'SMS' }] : []),
                { key: 'requests', label: 'Requests' },
                { key: 'communications', label: 'Communications' },
                { key: 'notes', label: 'Notes' },
                { key: 'files', label: 'Files' },
                { key: 'tasks', label: 'Tasks' },
                { key: 'engagements', label: 'Engagements', badge: engagements.length },
                { key: 'appointments', label: 'Appointments' },
              ]),
          { key: 'billing', label: 'Billing' },
          ...(client.accessRestricted ? [] : [{ key: 'tax', label: 'Tax' }]),
          ...(canViewCredentials && !client.accessRestricted
            ? [{ key: 'credentials', label: 'Credentials' }]
            : []),
        ]}
        active={tab}
        onChange={(k) => setTab(k as Tab)}
      />

      {tab === 'home' && (
        <>
          {summary && (
            <Card title="At a glance">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))',
                  gap: 16,
                }}
              >
                <Stat
                  label="Engagements"
                  value={`${summary.activeEngagementCount} / ${summary.engagementCount}`}
                />
                <Stat label="WIP" value={formatCents(summary.wipAmountCents)} />
                <Stat label="Invoiced" value={formatCents(summary.invoicedCents)} />
                <Stat label="Paid" value={formatCents(summary.paidCents)} />
                <Stat label="Outstanding" value={formatCents(summary.outstandingCents)} />
              </div>
            </Card>
          )}

          <ClientInfoCard
            client={client}
            onSaved={(updated) => setClient({ ...client, ...updated })}
          />

          <PeopleCard clientId={client.id} clientType={client.clientType ?? null} />

          <TasksCard clientId={client.id} compact users={staff} />

          {/* Files card disabled — v2 (B2-backed) ships in Phase 10. */}

          <TagsCustomFieldsCard
            client={client}
            onSaved={(updated) => setClient({ ...client, ...updated })}
          />
        </>
      )}

      {tab === 'messages' && <ClientMessagesCard clientId={client.id} />}

      {tab === 'sms' && <ClientSmsCard clientId={client.id} clientName={client.name} />}

      {tab === 'requests' && <ClientRequestsCard clientId={client.id} />}

      {tab === 'communications' && <CommunicationsCard clientId={client.id} />}

      {tab === 'notes' && <NotesCard clientId={client.id} />}

      {tab === 'files' && (
        <ClientFilesTab clientId={client.id} clientName={client.clientFacingName || client.name} />
      )}

      {tab === 'tasks' && <TasksCard clientId={client.id} users={staff} />}

      {tab === 'engagements' && (
        <>
          <RecurringEngagementsCard clientId={client.id} />
          <Card title={`Engagements (${engagements.length})`}>
            <Table<Engagement>
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  render: (e) => <a href={`/engagements/${e.id}`}>{e.name}</a>,
                },
                { key: 'fee', header: 'Fee structure', render: (e) => e.feeStructure },
                {
                  key: 'amt',
                  header: 'Fee amount',
                  align: 'right',
                  render: (e) => (e.feeAmountCents == null ? '—' : formatCents(e.feeAmountCents)),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (e) => (
                    <Pill tone={e.status === 'ACTIVE' ? 'success' : 'neutral'}>{e.status}</Pill>
                  ),
                },
                {
                  key: 'bill',
                  header: '',
                  align: 'right',
                  render: (e) => {
                    // Hidden when the engagement isn't ACTIVE or has no
                    // unbilled time. Cuts visual noise on the list and
                    // prevents launching the wizard against a batch
                    // with zero rows to include.
                    if (e.status !== 'ACTIVE') return null;
                    if ((e.unbilledEntryCount ?? 0) === 0) return null;
                    return (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          // Prefill the billing wizard with this client
                          // + engagement and a default month-to-date
                          // window.
                          const today = new Date();
                          const start = new Date(today.getFullYear(), today.getMonth(), 1)
                            .toISOString()
                            .slice(0, 10);
                          const end = today.toISOString().slice(0, 10);
                          const qs = new URLSearchParams({
                            clientId: client.id,
                            engagementId: e.id,
                            periodStart: start,
                            periodEnd: end,
                          }).toString();
                          window.location.href = `/billing?${qs}`;
                        }}
                        title={`Open the pre-bill wizard (${e.unbilledEntryCount} unbilled ${
                          e.unbilledEntryCount === 1 ? 'entry' : 'entries'
                        })`}
                      >
                        Bill →
                      </Button>
                    );
                  },
                },
              ]}
              rows={engagements}
              rowKey={(e) => e.id}
              empty="No engagements yet."
            />
          </Card>

          <Card
            title="Merge / dedup"
            action={
              <Button size="sm" variant="secondary" onClick={() => void openMerge()}>
                Merge another client into this one
              </Button>
            }
          >
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              Re-points every engagement, invoice, rate override, note, portal access, invitation,
              and active session from the source client onto this one, then archives the source.
              Refuses when either client is under legal hold.
            </p>
            {showMerge && (
              <MergeDialog
                target={client}
                allClients={allClients.filter((c) => c.id !== client.id && c.status === 'ACTIVE')}
                onClose={() => setShowMerge(false)}
                onMerged={() => {
                  setShowMerge(false);
                  void load();
                }}
              />
            )}
          </Card>
        </>
      )}

      {tab === 'appointments' && <ClientAppointmentsCard clientId={client.id} />}

      {tab === 'billing' && (
        <BillingCard clientId={client.id} clientName={client.clientFacingName || client.name} />
      )}

      {tab === 'tax' && (
        <>
          <ClientTaxReturnsCard clientId={client.id} />
          <TaxPaymentsCard clientId={client.id} />
        </>
      )}

      {tab === 'credentials' && canViewCredentials && (
        <ClientCredentialsCard clientId={client.id} />
      )}
    </div>
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

function TagsCustomFieldsCard({
  client,
  onSaved,
}: {
  client: Client;
  onSaved: (patch: Partial<Client>) => void;
}): JSX.Element {
  const [tags, setTags] = useState<string[]>(client.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [fields, setFields] = useState<Array<{ key: string; value: string }>>(() =>
    Object.entries(client.customFields ?? {}).map(([k, v]) => ({ key: k, value: String(v ?? '') })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function addTag(): void {
    const t = tagInput.trim();
    if (!t || tags.includes(t) || tags.length >= 20) return;
    setTags([...tags, t]);
    setTagInput('');
  }

  function removeTag(t: string): void {
    setTags(tags.filter((x) => x !== t));
  }

  function addField(): void {
    if (fields.length >= 30) return;
    setFields([...fields, { key: '', value: '' }]);
  }

  function updateField(i: number, k: 'key' | 'value', v: string): void {
    setFields(fields.map((f, idx) => (idx === i ? { ...f, [k]: v } : f)));
  }

  function removeField(i: number): void {
    setFields(fields.filter((_, idx) => idx !== i));
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setStatus(null);
    const customFields: Record<string, string> = {};
    for (const f of fields) {
      if (f.key.trim()) customFields[f.key.trim()] = f.value;
    }
    try {
      await api(`/api/staff/clients/${client.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tags, customFields }),
      });
      onSaved({ tags, customFields });
      setStatus('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Tags + custom fields"
      action={
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <div>
          <div
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            Tags
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {tags.map((t) => (
              <span
                key={t}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.pill,
                  fontSize: 12,
                  color: tokens.color.text,
                }}
              >
                {t}
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => removeTag(t)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tokens.color.textMuted,
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            {tags.length === 0 && (
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>No tags.</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="add tag and press Enter"
              style={{
                flex: 1,
                padding: '6px 10px',
                background: tokens.color.surface,
                color: tokens.color.text,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                fontSize: 13,
              }}
            />
            <Button size="sm" variant="secondary" onClick={addTag}>
              Add
            </Button>
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            Custom fields
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {fields.map((f, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 2fr auto',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <input
                  value={f.key}
                  onChange={(e) => updateField(i, 'key', e.target.value)}
                  placeholder="field name"
                  style={{
                    padding: '6px 10px',
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    fontSize: 13,
                  }}
                />
                <input
                  value={f.value}
                  onChange={(e) => updateField(i, 'value', e.target.value)}
                  placeholder="value"
                  style={{
                    padding: '6px 10px',
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    fontSize: 13,
                  }}
                />
                <button
                  type="button"
                  aria-label="Remove field"
                  onClick={() => removeField(i)}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    color: tokens.color.textMuted,
                    cursor: 'pointer',
                    padding: '4px 10px',
                    fontSize: 13,
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={addField}>
              + Add field
            </Button>
          </div>
        </div>

        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {status && <p style={{ color: tokens.color.success, fontSize: 12 }}>{status}</p>}
      </div>
    </Card>
  );
}

function MergeDialog({
  target,
  allClients,
  onClose,
  onMerged,
}: {
  target: Client;
  allClients: ClientLite[];
  onClose: () => void;
  onMerged: () => void;
}): JSX.Element {
  const [sourceId, setSourceId] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function doMerge(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!sourceId) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{
        ok: boolean;
        moved: Record<string, number>;
      }>(`/api/staff/clients/${target.id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ sourceId, reason: reason || undefined }),
      });
      setCounts(r.moved);
      setTimeout(onMerged, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'merge failed');
    } finally {
      setBusy(false);
    }
  }

  const sourceClient = allClients.find((c) => c.id === sourceId);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 20,
      }}
    >
      <button
        type="button"
        aria-label="Close merge dialog"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      />
      <div
        style={{
          position: 'relative',
          maxWidth: 520,
          width: '100%',
          background: tokens.color.bg,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          padding: 20,
        }}
      >
        <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>Merge client into {target.name}</h2>
        {counts ? (
          <>
            <p style={{ color: tokens.color.success, fontSize: 14 }}>
              Merge completed. Re-pointed:
            </p>
            <ul style={{ fontSize: 13, color: tokens.color.text }}>
              {Object.entries(counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => (
                  <li key={k}>
                    {k}: {n}
                  </li>
                ))}
            </ul>
          </>
        ) : (
          <form onSubmit={doMerge} style={{ display: 'grid', gap: 12 }}>
            <label style={{ fontSize: 13 }}>
              Source client (will be archived)
              <select
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                required
                disabled={busy}
                style={{
                  marginTop: 4,
                  padding: '8px 10px',
                  width: '100%',
                  background: tokens.color.surface,
                  color: tokens.color.text,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                }}
              >
                <option value="">— Select source —</option>
                {allClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Reason (optional, audit-logged)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="duplicate record / acquired entity / etc."
              disabled={busy}
            />
            {confirming && sourceClient && (
              <div
                style={{
                  padding: 10,
                  border: `1px solid ${tokens.color.warning}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                  color: tokens.color.warning,
                  background: 'rgba(245,158,11,0.08)',
                }}
              >
                Confirm: all engagements, invoices, rate overrides, notes, portal accesses, and
                invitations from <strong>{sourceClient.name}</strong> will move to{' '}
                <strong>{target.name}</strong>. The source will be archived. This action is
                audit-logged and cannot be undone in v1.
              </div>
            )}
            {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !sourceId}>
                {busy ? 'Merging…' : confirming ? 'Confirm merge' : 'Continue'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// BK-8 — client appointments tab. Lists this client's appointments and
// deep-links to the booking wizard.
interface ClientApptRow {
  id: string;
  title: string;
  startsAt: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  location: 'VIDEO' | 'PHONE' | 'IN_PERSON';
}

function ClientAppointmentsCard({ clientId }: { clientId: string }): JSX.Element {
  const [rows, setRows] = useState<ClientApptRow[]>([]);
  useEffect(() => {
    void api<{ items: ClientApptRow[] }>(`/api/staff/appointments?clientId=${clientId}`)
      .then((r) => setRows(r.items ?? []))
      .catch(() => setRows([]));
  }, [clientId]);
  return (
    <Card
      title={`Appointments (${rows.length})`}
      action={
        <Button
          size="sm"
          onClick={() => {
            window.location.href = `/appointments?clientId=${clientId}#book`;
          }}
        >
          Book appointment
        </Button>
      }
    >
      <Table<ClientApptRow>
        columns={[
          {
            key: 'when',
            header: 'Date & time',
            render: (r) => new Date(r.startsAt).toLocaleString(),
          },
          { key: 'title', header: 'Subject', render: (r) => r.title },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Pill
                tone={
                  r.status === 'SCHEDULED'
                    ? 'accent'
                    : r.status === 'COMPLETED'
                      ? 'success'
                      : 'neutral'
                }
              >
                {r.status.toLowerCase()}
              </Pill>
            ),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        empty="No appointments for this client yet."
      />
    </Card>
  );
}
