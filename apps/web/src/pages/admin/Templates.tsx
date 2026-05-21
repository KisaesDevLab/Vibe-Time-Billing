// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface WorkCode {
  key: string;
  name: string;
  billable_default: boolean;
  in_scope_default: boolean;
}

interface Template {
  key: string;
  name: string;
  service_line_category: string;
  default_fee_structure: string;
  default_fee_amount_cents: number | null;
  default_budget_hours: number | null;
  default_partner_review_required: boolean;
  work_codes: WorkCode[];
}

interface Pack {
  version: string;
  description: string;
  templates: Template[];
}

const formatCents = (c: number | null): string =>
  c == null ? '—' : `$${(c / 100).toLocaleString()}`;

export function TemplatesPage(): JSX.Element {
  const [pack, setPack] = useState<Pack | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<Pack>('/api/staff/taxonomy/engagement-template-pack');
        setPack(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  if (error) return <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>;
  if (!pack) return <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title={`Engagement template starter pack · v${pack.version}`}>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          {pack.description}
        </p>
        <Table<Template>
          columns={[
            { key: 'name', header: 'Template', render: (t) => t.name },
            {
              key: 'cat',
              header: 'Category',
              render: (t) => <Pill>{t.service_line_category}</Pill>,
            },
            {
              key: 'fee',
              header: 'Fee structure',
              render: (t) => <code style={{ fontSize: 11 }}>{t.default_fee_structure}</code>,
            },
            {
              key: 'amt',
              header: 'Default fee',
              align: 'right',
              render: (t) => formatCents(t.default_fee_amount_cents),
            },
            {
              key: 'h',
              header: 'Budget hours',
              align: 'right',
              render: (t) =>
                t.default_budget_hours == null ? '—' : t.default_budget_hours.toString(),
            },
            {
              key: 'wc',
              header: 'Work codes',
              align: 'right',
              render: (t) => String(t.work_codes.length),
            },
          ]}
          rows={pack.templates}
          rowKey={(t) => t.key}
          empty="Pack is empty."
        />
      </Card>
    </div>
  );
}
