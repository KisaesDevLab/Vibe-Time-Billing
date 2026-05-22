// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Token {
  id: string;
  label: string;
  status: 'ACTIVE' | 'REVOKED';
  allowedTools: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

const MCP_TOOLS = [
  'list_engagements',
  'get_time_entries',
  'create_time_entry',
  'query_recurring_plans',
  'generate_pre_bill',
  'suggest_adjustment',
  'query_realization',
];

export function ApiTokensPage(): JSX.Element {
  const [items, setItems] = useState<Token[]>([]);
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Token[] }>('/api/staff/admin/api-tokens');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function toggle(t: string): void {
    const next = new Set(selected);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setSelected(next);
  }

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setCreatedToken(null);
    try {
      const r = await api<{ token: string }>('/api/staff/admin/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ label, allowedTools: Array.from(selected) }),
      });
      setCreatedToken(r.token);
      setLabel('');
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function revoke(id: string): Promise<void> {
    if (!confirm('Revoke this token?')) return;
    try {
      await api(`/api/staff/admin/api-tokens/${id}/revoke`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Create MCP token (Q13)">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Tokens authorize AI agents to call specific MCP tools on this firm. Pick the smallest set
          of tools the agent needs. The token is hashed at rest; the plaintext is shown exactly once
          below.
        </p>
        <form onSubmit={create} style={{ display: 'grid', gap: 12 }}>
          <Input
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Claude Desktop"
            required
          />
          <div>
            <div style={{ fontSize: 13, color: tokens.color.textMuted, marginBottom: 6 }}>
              Allowed tools
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {MCP_TOOLS.map((t) => (
                <label
                  key={t}
                  style={{
                    fontSize: 11,
                    fontFamily: tokens.font.mono,
                    padding: '4px 8px',
                    borderRadius: tokens.radius.pill,
                    border: `1px solid ${selected.has(t) ? tokens.color.accent : tokens.color.border}`,
                    cursor: 'pointer',
                    background: selected.has(t) ? tokens.color.accent + '20' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(t)}
                    onChange={() => toggle(t)}
                    style={{ marginRight: 6 }}
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>
          <div>
            <Button type="submit">Create token</Button>
          </div>
        </form>
        {createdToken && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              background: tokens.color.warning + '20',
              border: `1px solid ${tokens.color.warning}`,
              borderRadius: tokens.radius.sm,
              fontSize: 12,
            }}
          >
            <strong>Token (copy now — shown only once):</strong>
            <code
              style={{
                display: 'block',
                marginTop: 6,
                wordBreak: 'break-all',
                fontFamily: tokens.font.mono,
              }}
            >
              {createdToken}
            </code>
          </div>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title={`Tokens (${items.length})`}>
        <Table<Token>
          columns={[
            { key: 'label', header: 'Label', render: (t) => t.label },
            {
              key: 'tools',
              header: 'Tools',
              render: (t) => (
                <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {t.allowedTools.length} tool{t.allowedTools.length === 1 ? '' : 's'}
                </span>
              ),
            },
            {
              key: 'last',
              header: 'Last used',
              render: (t) => (t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'),
            },
            {
              key: 'status',
              header: 'Status',
              render: (t) => (
                <Pill tone={t.status === 'ACTIVE' ? 'success' : 'danger'}>{t.status}</Pill>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: (t) =>
                t.status === 'ACTIVE' ? (
                  <Button size="sm" variant="secondary" onClick={() => void revoke(t.id)}>
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
          rows={items}
          rowKey={(t) => t.id}
          empty="No tokens yet."
        />
      </Card>
    </div>
  );
}
