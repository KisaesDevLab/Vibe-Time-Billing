// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { VIEWER_REPORTS } from '../reports/ReportViewer';

const VIEWER_KINDS = new Set(VIEWER_REPORTS.map((r) => r.kind));

// Turn a saved report's kind + params into a destination URL: a dedicated page
// where one exists, the generic viewer for API-only reports, else the Reports
// page (where dso / mrr / revenue-pop are rendered inline).
function openHref(kind: string, params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v == null || typeof v === 'object') continue;
    // The realization card reads its dimension from `dim`.
    const key = kind === 'realization' && k === 'dimension' ? 'dim' : k;
    qs.set(key, String(v));
  }
  const q = qs.toString() ? `?${qs.toString()}` : '';
  // Preserve the saved params everywhere — dedicated pages read them from
  // the query string too (they used to be silently dropped for
  // profitability / dso / revenue-period-over-period).
  if (kind === 'profitability') return `/reports/profitability${q}`;
  if (kind === 'realization') return `/reports${q}`;
  if (VIEWER_KINDS.has(kind)) return `/reports/view/${kind}${q}`;
  return `/reports${q}`;
}

interface SavedReport {
  id: string;
  name: string;
  reportKind: string;
  paramsJson: Record<string, unknown>;
  sharedFlag: boolean;
  ownerId: string;
  createdAt: string;
}

const KINDS = [
  'realization',
  'profitability',
  'utilization',
  'effective-rate',
  'dso',
  'mrr',
  'book-of-business',
  'clv',
  'scope-creep',
  'revenue-period-over-period',
];

export function SavedReportsPage(): JSX.Element {
  const [items, setItems] = useState<SavedReport[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState(KINDS[0]!);
  const [shared, setShared] = useState(false);
  const [params, setParams] = useState('{}');
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When set, the form edits an existing saved report (PATCH) instead of
  // creating a new one. Report kind is immutable once saved, so the select
  // is disabled while editing.
  const [editingId, setEditingId] = useState<string | null>(null);

  function resetForm(): void {
    setEditingId(null);
    setName('');
    setKind(KINDS[0]!);
    setParams('{}');
    setShared(false);
    setError(null);
  }

  function startEdit(r: SavedReport): void {
    setEditingId(r.id);
    setName(r.name);
    setKind(r.reportKind);
    setParams(JSON.stringify(r.paramsJson ?? {}, null, 2));
    setShared(r.sharedFlag);
    setError(null);
  }

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: SavedReport[] }>('/api/staff/saved-reports');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(params) as Record<string, unknown>;
    } catch {
      setError('Params JSON is invalid');
      return;
    }
    try {
      if (editingId) {
        // reportKind is immutable; PATCH only the editable fields.
        await api(`/api/staff/saved-reports/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, paramsJson: parsed, shared }),
        });
      } else {
        await api('/api/staff/saved-reports', {
          method: 'POST',
          body: JSON.stringify({ name, reportKind: kind, paramsJson: parsed, shared }),
        });
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function suggestParams(): Promise<void> {
    const prompt = window.prompt(
      `Describe the report in plain English and AI will fill in the parameters for "${kind}":`,
    );
    if (!prompt || !prompt.trim()) return;
    setError(null);
    setSuggesting(true);
    try {
      const r = await api<{ params: Record<string, unknown> }>('/api/staff/ai/report-params', {
        method: 'POST',
        body: JSON.stringify({ reportKind: kind, prompt: prompt.trim() }),
      });
      setParams(JSON.stringify(r.params ?? {}, null, 2));
    } catch (err) {
      setError(
        err instanceof Error ? `AI suggestion failed: ${err.message}` : 'AI suggestion failed',
      );
    } finally {
      setSuggesting(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/api/staff/saved-reports/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title={editingId ? 'Edit saved report' : 'Save a report definition'}>
        <form onSubmit={submit} style={{ display: 'grid', gap: 12, maxWidth: 600 }}>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label style={{ fontSize: 13 }}>
            Report kind{editingId ? ' (cannot be changed)' : ''}
            <select
              value={kind}
              disabled={editingId !== null}
              onChange={(e) => setKind(e.target.value)}
              style={{
                marginTop: 4,
                padding: '6px 8px',
                width: '100%',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            <span
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              Params JSON
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={suggesting}
                onClick={() => void suggestParams()}
              >
                {suggesting ? 'Thinking…' : '✨ Suggest with AI'}
              </Button>
            </span>
            <textarea
              value={params}
              onChange={(e) => setParams(e.target.value)}
              rows={4}
              style={{
                marginTop: 4,
                width: '100%',
                fontFamily: tokens.font.mono,
                fontSize: 12,
                padding: 8,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
              placeholder='{"dimension":"timekeeper"} or {"days":30}'
            />
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Shared firm-wide
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="submit">{editingId ? 'Update' : 'Save'}</Button>
            {editingId && (
              <Button type="button" variant="secondary" onClick={resetForm}>
                Cancel
              </Button>
            )}
          </div>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Saved reports">
        <Table<SavedReport>
          columns={[
            { key: 'name', header: 'Name', render: (r) => r.name },
            { key: 'kind', header: 'Kind', render: (r) => r.reportKind },
            {
              key: 'params',
              header: 'Params',
              render: (r) => <code style={{ fontSize: 11 }}>{JSON.stringify(r.paramsJson)}</code>,
            },
            {
              key: 'shared',
              header: 'Shared',
              render: (r) => (
                <Pill tone={r.sharedFlag ? 'accent' : 'neutral'}>
                  {r.sharedFlag ? 'firm-wide' : 'private'}
                </Pill>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: (r) => (
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <Button
                    size="sm"
                    onClick={() => {
                      window.location.href = openHref(r.reportKind, r.paramsJson);
                    }}
                  >
                    Open
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => startEdit(r)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void remove(r.id)}>
                    Delete
                  </Button>
                </span>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No saved reports yet."
        />
      </Card>
    </div>
  );
}
