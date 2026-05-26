// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §6 Phase D — single-conflict resolution page (mockup 4).

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Card, Pill, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

interface DetailResponse {
  attempt: {
    id: string;
    storage_path: string;
    attempted_by: string;
    attempted_at: string;
    match_confidence: number | null;
    outcome: string;
  };
  folder: {
    storage_path: string;
    sentinel: {
      version: number;
      client_id: string;
      firm_id: string;
      created_at: string;
      created_by: string | null;
      display_name_at_creation: string;
    } | null;
  };
  currently_bound: {
    client_id: string;
    client_name: string;
    tax_software_id: string | null;
    client_status: string;
    name_fuzzy_score: number;
    binding_age_days: number;
  } | null;
  challenger: {
    client_id: string;
    client_name: string;
    tax_software_id: string | null;
    client_status: string;
    name_fuzzy_score: number;
  } | null;
  recommendation: {
    action: 'keep_current' | 'reassign' | 'unbind_both';
    rationale: string;
  };
  audit_trail: {
    ts: string;
    actor: string | null;
    event: string;
    detail: string | null;
  }[];
}

type Action = 'keep_current' | 'reassign' | 'unbind_both';

export function StorageConflictResolutionPage(): JSX.Element {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [action, setAction] = useState<Action>('keep_current');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!attemptId) return;
    setError(null);
    try {
      const r = await api<DetailResponse>(`/api/staff/storage/conflicts/${attemptId}`);
      setData(r);
      setAction(r.recommendation.action);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitDisabled = busy || (action !== 'keep_current' && reason.trim().length < 10);

  async function submit(): Promise<void> {
    if (!attemptId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/storage/conflicts/${attemptId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          reason: action === 'keep_current' ? undefined : reason.trim(),
        }),
      });
      navigate('/admin/storage/conflicts');
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <Card title="Conflict detail">
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card title="Conflict detail">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Admin → Storage → Conflicts →{' '}
        <code style={{ fontFamily: tokens.font.mono }}>{data.attempt.storage_path}</code>{' '}
        <Pill tone="warning">{data.attempt.outcome}</Pill>
      </div>

      <Card title="Folder">
        <FolderSummaryCard folder={data.folder} />
      </Card>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: tokens.space.md,
        }}
      >
        <Card title="Currently bound">
          {data.currently_bound ? (
            <ClientComparisonCard
              kind="current"
              client={data.currently_bound}
              binding_age_days={data.currently_bound.binding_age_days}
            />
          ) : (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              No current binding — folder is unbound.
            </p>
          )}
        </Card>
        <Card title="Challenger">
          {data.challenger ? (
            <ClientComparisonCard kind="challenger" client={data.challenger} />
          ) : (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Unknown challenger.</p>
          )}
        </Card>
      </div>

      <Card title="Recommendation">
        <RecommendationPanel rec={data.recommendation} />
      </Card>

      <Card title="Resolution">
        <ResolutionForm
          action={action}
          onActionChange={setAction}
          reason={reason}
          onReasonChange={setReason}
          submitDisabled={submitDisabled}
          submitting={busy}
          onSubmit={submit}
          onCancel={() => navigate('/admin/storage/conflicts')}
          error={error}
        />
      </Card>

      <Card title="Audit trail">
        <AuditTrailPanel events={data.audit_trail} />
      </Card>
    </div>
  );
}

function FolderSummaryCard({ folder }: { folder: DetailResponse['folder'] }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div>
        <code style={{ fontFamily: tokens.font.mono, fontSize: 14 }}>{folder.storage_path}</code>
      </div>
      {folder.sentinel ? (
        <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Sentinel: client_id <code>{folder.sentinel.client_id}</code>, written{' '}
          {new Date(folder.sentinel.created_at).toLocaleString()} by{' '}
          {folder.sentinel.created_by ?? '(unknown)'}. Display name at creation:{' '}
          <em>{folder.sentinel.display_name_at_creation}</em>.
        </div>
      ) : (
        <div style={{ fontSize: 12, color: tokens.color.warning }}>
          No sentinel detected — folder is unbound or the sentinel was lost.
        </div>
      )}
    </div>
  );
}

interface ClientCardData {
  client_id: string;
  client_name: string;
  tax_software_id: string | null;
  client_status: string;
  name_fuzzy_score: number;
}

function ClientComparisonCard({
  kind,
  client,
  binding_age_days,
}: {
  kind: 'current' | 'challenger';
  client: ClientCardData;
  binding_age_days?: number;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{client.client_name}</strong>
        <Pill tone={kind === 'current' ? 'accent' : 'warning'}>
          {kind === 'current' ? 'Currently bound' : 'Challenger'}
        </Pill>
      </div>
      <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Tax software ID: {client.tax_software_id ?? '—'}
      </div>
      <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Status: {client.client_status}
      </div>
      <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Name match: {(client.name_fuzzy_score * 100).toFixed(0)}%
      </div>
      {binding_age_days != null && (
        <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Binding age: {binding_age_days} day{binding_age_days === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function RecommendationPanel({ rec }: { rec: DetailResponse['recommendation'] }): JSX.Element {
  const label =
    rec.action === 'keep_current'
      ? 'Keep current'
      : rec.action === 'reassign'
        ? 'Reassign to challenger'
        : 'Unbind both';
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <span style={{ fontSize: 20 }}>💡</span>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 13, color: tokens.color.textMuted, lineHeight: 1.5 }}>
          {rec.rationale}
        </div>
      </div>
    </div>
  );
}

function ResolutionForm({
  action,
  onActionChange,
  reason,
  onReasonChange,
  submitDisabled,
  submitting,
  onSubmit,
  onCancel,
  error,
}: {
  action: Action;
  onActionChange: (a: Action) => void;
  reason: string;
  onReasonChange: (r: string) => void;
  submitDisabled: boolean;
  submitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  error: string | null;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div role="radiogroup" style={{ display: 'grid', gap: 8 }}>
        <ResolutionOption
          value="keep_current"
          checked={action === 'keep_current'}
          onChange={onActionChange}
          title="Keep current binding"
          desc="Deny the challenger. The current client keeps the folder."
        />
        <ResolutionOption
          value="reassign"
          checked={action === 'reassign'}
          onChange={onActionChange}
          title="Reassign to challenger"
          desc="Transfer the folder + sentinel + file rows to the challenger client. The original client becomes unbound."
        />
        <ResolutionOption
          value="unbind_both"
          checked={action === 'unbind_both'}
          onChange={onActionChange}
          title="Unbind both"
          desc="Both clients become unbound. The folder is left in the bucket for staff to re-link manually."
        />
      </div>

      {action !== 'keep_current' && (
        <div>
          <label
            htmlFor="fmv2-conflict-reason"
            style={{ display: 'block', fontSize: 12, marginBottom: 4 }}
          >
            Reason (required, ≥ 10 characters)
          </label>
          <textarea
            id="fmv2-conflict-reason"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            rows={3}
            style={{
              width: '100%',
              padding: 8,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              fontSize: 13,
              resize: 'vertical',
            }}
          />
          {reason.length > 0 && reason.length < 10 && (
            <div style={{ fontSize: 11, color: tokens.color.danger, marginTop: 4 }}>
              At least 10 characters required.
            </div>
          )}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 10,
            background: 'rgba(220, 38, 38, 0.1)',
            border: `1px solid ${tokens.color.danger}`,
            borderRadius: tokens.radius.sm,
            fontSize: 13,
            color: tokens.color.danger,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: 8,
          borderTop: `1px solid ${tokens.color.border}`,
        }}
      >
        <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
          Requires <code>storage:folder:reconcile</code> permission.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              cursor: submitting ? 'wait' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            style={{
              padding: '6px 12px',
              background: submitDisabled ? tokens.color.border : tokens.color.accent,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radius.sm,
              cursor: submitDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'Applying…' : 'Apply resolution'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResolutionOption({
  value,
  checked,
  onChange,
  title,
  desc,
}: {
  value: Action;
  checked: boolean;
  onChange: (a: Action) => void;
  title: string;
  desc: string;
}): JSX.Element {
  const inputId = `fmv2-resolution-${value}`;
  return (
    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the htmlFor + nested <input id={inputId}> satisfies the spec; the rule's heuristic misses the nested case.
    <label
      htmlFor={inputId}
      aria-label={title}
      style={{
        display: 'flex',
        gap: 10,
        padding: 10,
        border: `1px solid ${checked ? tokens.color.accent : tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        cursor: 'pointer',
        background: checked ? 'rgba(67, 56, 202, 0.04)' : 'transparent',
      }}
    >
      <input
        id={inputId}
        type="radio"
        name="resolution"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        style={{ marginTop: 3 }}
      />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 2 }}>{desc}</div>
      </div>
    </label>
  );
}

function AuditTrailPanel({ events }: { events: DetailResponse['audit_trail'] }): JSX.Element {
  if (events.length === 0) {
    return (
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        No events recorded for this folder yet.
      </p>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {events.map((e, i) => (
        <div
          key={`${e.ts}-${i}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '160px 120px 120px 1fr',
            gap: 8,
            fontSize: 12,
            padding: '4px 0',
            borderBottom: i < events.length - 1 ? `1px solid ${tokens.color.border}` : 'none',
          }}
        >
          <span style={{ color: tokens.color.textMuted }}>{new Date(e.ts).toLocaleString()}</span>
          <span>{e.actor ?? 'system'}</span>
          <span>
            <Pill tone="neutral">{e.event}</Pill>
          </span>
          <span style={{ color: tokens.color.textMuted }}>{e.detail ?? ''}</span>
        </div>
      ))}
    </div>
  );
}
