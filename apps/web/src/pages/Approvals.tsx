// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';
import { usePermission } from '../auth-context';
import { StagedNotificationsCard } from './StagedNotificationsCard';

interface PendingRequest {
  id: string;
  entityType: 'ADJUSTMENT' | 'PRE_BILL' | 'INVOICE' | 'ENGAGEMENT_LETTER' | 'RATE_CHANGE';
  entityId: string;
  requesterId: string;
  requesterName: string;
  status: string;
  requestedAt: string;
  comments: string | null;
  currentStep: number;
  totalSteps: number;
}

export function ApprovalsPage(): JSX.Element {
  const [items, setItems] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ items: PendingRequest[] }>('/api/staff/approvals/pending');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function decide(id: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/staff/approvals/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, comments: comments || undefined }),
      });
      setActiveId(null);
      setComments('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setSubmitting(false);
    }
  }

  const canManagePortal = usePermission('client:portal-access:manage');
  const canApproveNotifications = usePermission('notification:approve');

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      {canManagePortal && <PortalAccessRequestsCard />}
      {canApproveNotifications && <StagedNotificationsCard />}
      <Card title={`Pending approvals (${items.length})`}>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<PendingRequest>
            columns={[
              {
                key: 'type',
                header: 'Type',
                render: (r) => <Pill>{r.entityType.replace('_', ' ').toLowerCase()}</Pill>,
              },
              { key: 'req', header: 'Requested by', render: (r) => r.requesterName },
              {
                key: 'when',
                header: 'When',
                render: (r) => new Date(r.requestedAt).toLocaleString(),
              },
              {
                key: 'entity',
                header: 'Entity',
                render: (r) => <code style={{ fontSize: 11 }}>{r.entityId.slice(0, 8)}…</code>,
              },
              {
                key: 'step',
                header: 'Step',
                render: (r) =>
                  r.totalSteps > 1 ? (
                    <Pill tone={r.currentStep === r.totalSteps ? 'warning' : 'neutral'}>
                      {r.currentStep} / {r.totalSteps}
                    </Pill>
                  ) : (
                    <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>—</span>
                  ),
              },
              {
                key: 'actions',
                header: '',
                render: (r) =>
                  activeId === r.id ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <Input
                        placeholder="Optional comments"
                        value={comments}
                        onChange={(e) => setComments(e.target.value)}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Button
                          size="sm"
                          onClick={() => void decide(r.id, 'APPROVED')}
                          disabled={submitting}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void decide(r.id, 'REJECTED')}
                          disabled={submitting}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setActiveId(null);
                            setComments('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" onClick={() => setActiveId(r.id)}>
                      Review
                    </Button>
                  ),
              },
            ]}
            rows={items}
            rowKey={(r) => r.id}
            empty="No pending approvals."
          />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------
// Portal access requests — self-service requests submitted from the
// client portal. One row per (person, client); approve grants portal
// access at a chosen role, deny records the decision. Gated on
// client:portal-access:manage by the parent.
// ---------------------------------------------------------------------

interface AccessRequest {
  id: string;
  personId: string;
  personName: string;
  clientId: string;
  clientName: string;
  email: string | null;
  phone: string | null;
  idType: 'SSN_LAST4' | 'EIN';
  idValue: string;
  createdAt: string;
}

const ROLE_OPTIONS: ComboboxOption[] = [
  { value: 'FULL', label: 'Full access' },
  { value: 'VIEW_ONLY', label: 'View only' },
  { value: 'PAY_ONLY', label: 'Pay only' },
];

function PortalAccessRequestsCard(): JSX.Element {
  const [items, setItems] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ items: AccessRequest[] }>('/api/staff/portal-access-requests');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function act(id: string, action: 'approve' | 'deny'): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/staff/portal-access-requests/${id}/${action}`, {
        method: 'POST',
        body: action === 'approve' ? JSON.stringify({ role: roles[id] ?? 'FULL' }) : '{}',
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card title={`Portal access requests (${items.length})`}>
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Self-service requests from the client portal. Verify the ID against your records before
        approving. A person on multiple clients appears once per client.
      </p>
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      {loading ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : (
        <Table<AccessRequest>
          columns={[
            { key: 'name', header: 'Name', render: (r) => r.personName },
            {
              key: 'client',
              header: 'Client',
              render: (r) => <a href={`/clients/${r.clientId}`}>{r.clientName}</a>,
            },
            { key: 'email', header: 'Email', render: (r) => r.email ?? '—' },
            { key: 'phone', header: 'Phone', render: (r) => r.phone ?? '—' },
            {
              key: 'id',
              header: 'ID',
              render: (r) => (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {r.idType === 'SSN_LAST4' ? `SSN ••• ${r.idValue}` : `EIN ••• ${r.idValue}`}
                </span>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: (r) => (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 130 }}>
                    <Combobox
                      ariaLabel="Role"
                      value={roles[r.id] ?? 'FULL'}
                      onChange={(v) => setRoles((m) => ({ ...m, [r.id]: v }))}
                      options={ROLE_OPTIONS}
                    />
                  </div>
                  <Button
                    size="sm"
                    disabled={busyId === r.id}
                    onClick={() => void act(r.id, 'approve')}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === r.id}
                    onClick={() => void act(r.id, 'deny')}
                  >
                    Deny
                  </Button>
                </div>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No pending portal access requests."
        />
      )}
    </Card>
  );
}
