// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Signatures list (P8). Firm-wide e-signature requests built on OpenSign:
// arbitrary PDFs with drag-placed fields and multiple signers. Lists
// requests with a status filter; "New request" opens the create dialog
// (title + form type + signers → a draft), then routes to the detail page
// where the PDF is uploaded, fields placed, and the request sent.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Combobox, Input, Pill, Table, tokens, type TableColumn } from '@vibe/ui';

import { api } from '../api-client';
import { usePermission } from '../auth-context';

interface RequestRow {
  id: string;
  title: string;
  status: string;
  clientId: string | null;
  formType: string | null;
  signerCount: number;
  signedCount: number;
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'partially_signed', label: 'Partially signed' },
  { value: 'completed', label: 'Completed' },
  { value: 'declined', label: 'Declined' },
  { value: 'expired', label: 'Expired' },
  { value: 'voided', label: 'Voided' },
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

export function SignaturesPage(): JSX.Element {
  const navigate = useNavigate();
  const canWrite = usePermission('proposal:write');
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      const r = await api<{ requests: RequestRow[] }>(`/api/staff/signatures${qs}`);
      setRows(r.requests ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const columns: TableColumn<RequestRow>[] = [
    {
      key: 'title',
      header: 'Title',
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
    { key: 'formType', header: 'Form', render: (r) => r.formType ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Pill tone={statusTone(r.status)}>{statusLabel(r.status)}</Pill>,
    },
    {
      key: 'signers',
      header: 'Signed',
      align: 'center',
      render: (r) => `${r.signedCount}/${r.signerCount}`,
    },
    {
      key: 'sentAt',
      header: 'Sent',
      render: (r) => (r.sentAt ? new Date(r.sentAt).toLocaleDateString() : '—'),
    },
    {
      key: 'expiresAt',
      header: 'Expires',
      render: (r) => (r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : '—'),
    },
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title="Signatures"
        action={
          canWrite ? <Button onClick={() => setCreateOpen(true)}>+ New request</Button> : undefined
        }
      >
        <div style={{ display: 'flex', gap: 12, marginBottom: tokens.space.md, maxWidth: 280 }}>
          <Combobox
            options={STATUS_OPTIONS}
            value={status}
            onChange={setStatus}
            ariaLabel="Filter by status"
          />
        </div>
        {loading ? (
          <div style={{ color: tokens.color.textMuted, fontSize: 13, padding: tokens.space.md }}>
            Loading…
          </div>
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            empty="No signature requests yet."
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

  const valid =
    title.trim().length > 0 &&
    signers.length > 0 &&
    signers.every((s) => s.name.trim() && /.+@.+\..+/.test(s.email));

  function updateSigner(i: number, patch: Partial<SignerDraft>): void {
    setSigners((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  async function submit(): Promise<void> {
    if (!valid) {
      setError('A title and at least one signer (name + email) are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string }>('/api/staff/signatures', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          formType: formType || undefined,
          signers: signers.map((s) => ({
            name: s.name.trim(),
            email: s.email.trim(),
            role: s.role.trim() || undefined,
          })),
        }),
      });
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create_failed');
    } finally {
      setBusy(false);
    }
  }

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
      <div style={{ maxWidth: 640, width: '100%', maxHeight: '90vh', overflow: 'auto' }}>
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

            <div style={{ fontSize: 13, fontWeight: 600, color: tokens.color.text }}>Signers</div>
            {signers.map((s, i) => (
              <div
                key={i}
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
