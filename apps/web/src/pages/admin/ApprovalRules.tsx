// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Rule {
  id: string;
  name: string;
  entityType: string;
  status: string;
  priority: number;
  slaHours: number | null;
  autoEscalateHours: number | null;
}

export function ApprovalRulesPage(): JSX.Element {
  const [items, setItems] = useState<Rule[]>([]);
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('ADJUSTMENT');
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Rule[] }>('/api/staff/approvals/rules');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await api('/api/staff/approvals/rules', {
        method: 'POST',
        body: JSON.stringify({
          name,
          entityType,
          conditionsJson: {},
          approverResolutionJson: { kind: 'partner_in_charge' },
        }),
      });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/api/staff/approvals/rules/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Add approval rule">
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label style={{ fontSize: 13 }}>
            Entity type
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              style={{
                marginTop: 4,
                padding: '6px 8px',
                width: '100%',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
            >
              <option value="ADJUSTMENT">ADJUSTMENT</option>
              <option value="PRE_BILL">PRE_BILL</option>
              <option value="INVOICE">INVOICE</option>
              <option value="ENGAGEMENT_LETTER">ENGAGEMENT_LETTER</option>
              <option value="RATE_CHANGE">RATE_CHANGE</option>
            </select>
          </label>
          <Button type="submit">Add</Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Approval rules">
        <Table<Rule>
          columns={[
            { key: 'name', header: 'Name', render: (r) => r.name },
            { key: 'type', header: 'Entity', render: (r) => r.entityType },
            { key: 'pri', header: 'Priority', render: (r) => String(r.priority) },
            { key: 'sla', header: 'SLA', render: (r) => (r.slaHours ? `${r.slaHours}h` : '—') },
            {
              key: 'esc',
              header: 'Escalate',
              render: (r) => (r.autoEscalateHours ? `${r.autoEscalateHours}h` : '—'),
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => (
                <Pill tone={r.status === 'ACTIVE' ? 'accent' : 'neutral'}>{r.status}</Pill>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: (r) => (
                <Button size="sm" variant="secondary" onClick={() => void remove(r.id)}>
                  Archive
                </Button>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No rules yet."
        />
      </Card>
    </div>
  );
}
