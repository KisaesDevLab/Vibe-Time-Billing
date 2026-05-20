// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Rule {
  id: string;
  name: string;
  status: string;
  conditionsJson: Record<string, unknown>;
  requiredFields: string[];
}

const FIELD_HINTS = ['workCodeId', 'description', 'reasonCodeId', 'taskId'];

export function RequiredFieldRulesPage(): JSX.Element {
  const [items, setItems] = useState<Rule[]>([]);
  const [name, setName] = useState('');
  const [conditions, setConditions] = useState('{}');
  const [fields, setFields] = useState('description');
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Rule[] }>('/api/staff/required-field-rules');
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
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(conditions) as Record<string, unknown>;
    } catch {
      setError('Conditions JSON is invalid');
      return;
    }
    try {
      await api('/api/staff/required-field-rules', {
        method: 'POST',
        body: JSON.stringify({
          name,
          conditionsJson: parsed,
          requiredFields: fields
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean),
        }),
      });
      setName('');
      setConditions('{}');
      setFields('description');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/api/staff/required-field-rules/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Add required-field rule">
        <form onSubmit={create} style={{ display: 'grid', gap: 12 }}>
          <Input
            label="Rule name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <label style={{ fontSize: 13 }}>
            Conditions JSON
            <textarea
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              rows={4}
              style={{
                marginTop: 4,
                width: '100%',
                fontFamily: 'monospace',
                fontSize: 12,
                padding: 8,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
              placeholder='{"engagementTypeId":"…"} or {"workCodeId":"…"}'
            />
          </label>
          <Input
            label="Required fields (comma-separated)"
            value={fields}
            onChange={(e) => setFields(e.target.value)}
            placeholder={FIELD_HINTS.join(', ')}
          />
          <div>
            <Button type="submit">Add rule</Button>
          </div>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Required-field rules">
        <Table<Rule>
          columns={[
            { key: 'name', header: 'Name', render: (r) => r.name },
            {
              key: 'cond',
              header: 'Conditions',
              render: (r) => (
                <code style={{ fontSize: 11 }}>{JSON.stringify(r.conditionsJson)}</code>
              ),
            },
            {
              key: 'fields',
              header: 'Required fields',
              render: (r) => r.requiredFields.join(', '),
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
                  Delete
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
