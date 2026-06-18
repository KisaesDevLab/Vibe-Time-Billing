// Authored preview — @vibe/ui ChevronDown icon
import { ChevronDown, tokens } from '@vibe/ui';

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
        <ChevronDown size={36} color={tokens.color.accent} />
      </span>
      <ChevronDown size={40} color={tokens.color.text} />
      <ChevronDown size={28} color={tokens.color.textMuted} />
    </div>
  );
}
