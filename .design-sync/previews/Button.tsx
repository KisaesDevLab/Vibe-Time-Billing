// Authored preview — @vibe/ui Button
import { Button, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap' as const,
  alignItems: 'center',
};

export function Variants(): JSX.Element {
  return (
    <div style={frame}>
      <Button variant="primary">Save changes</Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="danger">Delete</Button>
      <Button variant="ghost">Dismiss</Button>
    </div>
  );
}

export function Sizes(): JSX.Element {
  return (
    <div style={frame}>
      <Button size="md">Generate invoice</Button>
      <Button size="sm">Add time</Button>
      <Button size="sm" variant="secondary">
        Export
      </Button>
    </div>
  );
}

export function Disabled(): JSX.Element {
  return (
    <div style={frame}>
      <Button disabled>Post pre-bill</Button>
      <Button variant="secondary" disabled>
        Approve
      </Button>
    </div>
  );
}
