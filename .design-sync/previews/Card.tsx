// Authored preview — @vibe/ui Card
import { Card, Button, Pill, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

const row = (label: string, value: string, muted = false) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      padding: '6px 0',
      borderBottom: `1px solid ${tokens.color.border}`,
      fontSize: 13,
      color: muted ? tokens.color.textMuted : tokens.color.text,
    }}
  >
    <span>{label}</span>
    <span>{value}</span>
  </div>
);

export function TitledWithAction(): JSX.Element {
  return (
    <div style={frame}>
      <Card
        title="Engagement summary"
        action={
          <Button size="sm" variant="secondary">
            Generate pre-bill
          </Button>
        }
        style={{ maxWidth: 420 }}
      >
        {row('Client', 'Hartwell Manufacturing LLC')}
        {row('Engagement', '1120-S — FY2025')}
        {row('Unbilled WIP', '$12,480.00')}
        {row('Realization (YTD)', '94%', true)}
      </Card>
    </div>
  );
}

export function PlainBody(): JSX.Element {
  return (
    <div style={frame}>
      <Card style={{ maxWidth: 420 }}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: tokens.color.text }}>
          No title or action slot — just a bordered surface. Used to group a time-entry form or a
          block of read-only detail on the engagement page.
        </p>
      </Card>
    </div>
  );
}

export function StatusCard(): JSX.Element {
  return (
    <div style={frame}>
      <Card
        title="Invoice #2026-0412"
        action={<Pill tone="warning">Past due</Pill>}
        style={{ maxWidth: 420 }}
      >
        {row('Billed to', 'Delgado Family Trust')}
        {row('Amount due', '$3,250.00')}
        {row('Due date', 'May 31, 2026')}
        <div style={{ marginTop: tokens.space.md, display: 'flex', gap: 8 }}>
          <Button size="sm">Send reminder</Button>
          <Button size="sm" variant="ghost">
            View PDF
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function CardGrid(): JSX.Element {
  return (
    <div
      style={{
        ...frame,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 16,
      }}
    >
      <Card title="Individual 1040">
        {row('Active engagements', '142')}
        {row('Avg. fee', '$640', true)}
      </Card>
      <Card title="Monthly Bookkeeping">
        {row('Active engagements', '38')}
        {row('Avg. fee', '$1,150', true)}
      </Card>
    </div>
  );
}
