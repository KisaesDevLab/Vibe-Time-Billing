// Authored preview — @vibe/ui Input
import { Input, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

export function LabeledFields(): JSX.Element {
  return (
    <div style={{ ...frame, display: 'grid', gap: 16, maxWidth: 360 }}>
      <Input label="Client legal name" defaultValue="Hartwell Manufacturing LLC" />
      <Input
        label="Default hourly rate"
        defaultValue="285.00"
        hint="Snapshotted onto each time entry at creation."
      />
    </div>
  );
}

export function Placeholder(): JSX.Element {
  return (
    <div style={{ ...frame, display: 'grid', gap: 16, maxWidth: 360 }}>
      <Input label="Engagement code" placeholder="e.g. 1120-S-2025" />
      <Input label="Search clients" placeholder="Search by name or EIN…" />
    </div>
  );
}

export function Invalid(): JSX.Element {
  return (
    <div style={{ ...frame, display: 'grid', gap: 16, maxWidth: 360 }}>
      <Input label="EIN" defaultValue="12-34" invalid hint="EIN must be 9 digits (XX-XXXXXXX)." />
      <Input label="Billing email" defaultValue="ar@delgado-trust.com" />
    </div>
  );
}
