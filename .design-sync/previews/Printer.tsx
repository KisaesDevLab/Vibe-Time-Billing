// Authored preview — @vibe/ui Printer icon
import { Printer, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 24,
  fontFamily: tokens.font.body,
  display: 'flex',
  gap: 16,
  alignItems: 'center',
};

const tile = {
  width: 64,
  height: 64,
  borderRadius: 14,
  background: tokens.color.accentMuted,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export function Icon(): JSX.Element {
  return (
    <div style={frame}>
      <span style={tile}>
        <Printer size={36} color={tokens.color.accent} />
      </span>
      <Printer size={40} color={tokens.color.text} />
      <Printer size={28} color={tokens.color.textMuted} />
    </div>
  );
}
