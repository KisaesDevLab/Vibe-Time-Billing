// Authored preview — @vibe/ui Pill
import { Pill, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap' as const,
  alignItems: 'center',
};

export function Tones(): JSX.Element {
  return (
    <div style={frame}>
      <Pill tone="neutral">Draft</Pill>
      <Pill tone="accent">In progress</Pill>
      <Pill tone="success">Paid</Pill>
      <Pill tone="warning">Due soon</Pill>
      <Pill tone="danger">Overdue</Pill>
    </div>
  );
}
