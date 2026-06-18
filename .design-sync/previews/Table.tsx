// Authored preview — @vibe/ui Table
import { Pill, Table, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

interface Row {
  id: string;
  client: string;
  engagement: string;
  status: 'In progress' | 'Review' | 'Billed';
  wip: string;
}

const ROWS: Row[] = [
  {
    id: '1',
    client: 'Allen, David',
    engagement: '1040 — 2024',
    status: 'In progress',
    wip: '$1,240',
  },
  {
    id: '2',
    client: 'Brightway LLC',
    engagement: 'Monthly bookkeeping',
    status: 'Review',
    wip: '$860',
  },
  { id: '3', client: 'Cedar Holdings', engagement: '1120-S — 2024', status: 'Billed', wip: '$0' },
];

const tone = (s: Row['status']): 'accent' | 'warning' | 'success' =>
  s === 'In progress' ? 'accent' : s === 'Review' ? 'warning' : 'success';

export function Engagements(): JSX.Element {
  return (
    <div style={frame}>
      <Table<Row>
        columns={[
          { key: 'client', header: 'Client', render: (r) => r.client },
          { key: 'engagement', header: 'Engagement', render: (r) => r.engagement },
          {
            key: 'status',
            header: 'Status',
            render: (r) => <Pill tone={tone(r.status)}>{r.status}</Pill>,
          },
          { key: 'wip', header: 'WIP', align: 'right', render: (r) => r.wip },
        ]}
        rows={ROWS}
        rowKey={(r) => r.id}
        footer={['', '', 'Total', '$2,100']}
      />
    </div>
  );
}

export function Empty(): JSX.Element {
  return (
    <div style={frame}>
      <Table<Row>
        columns={[
          { key: 'client', header: 'Client', render: (r) => r.client },
          { key: 'wip', header: 'WIP', align: 'right', render: (r) => r.wip },
        ]}
        rows={[]}
        rowKey={(r) => r.id}
        empty="No open engagements."
      />
    </div>
  );
}
