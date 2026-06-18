// Authored preview — @vibe/ui Stat
import { Stat, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

export function Dashboard(): JSX.Element {
  return (
    <div
      style={{
        ...frame,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 12,
      }}
    >
      <Stat label="WIP balance" value="$48,250" caption="+$3,100 this week" tone="accent" />
      <Stat label="Realization" value="92%" tone="success" caption="Target 90%" />
      <Stat label="Overdue invoices" value="7" tone="danger" caption="$12,400 outstanding" />
      <Stat label="Unbilled hours" value="134.5" tone="warning" />
    </div>
  );
}

export function Single(): JSX.Element {
  return (
    <div style={frame}>
      <Stat
        label="This month's collections"
        value="$86,900"
        tone="success"
        caption="+18% vs. last month"
      />
    </div>
  );
}
