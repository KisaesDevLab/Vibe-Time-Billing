// Authored preview — @vibe/ui FontSizeControl
// NOTE: FontSizeControl calls useFontScale(), which is self-contained
// (reads/writes localStorage + applies body{zoom}). No provider needed.
// The segmented A− / % / A+ control renders standalone; default shows 100%.
import { FontSizeControl, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

export function Standalone(): JSX.Element {
  return (
    <div style={frame}>
      <FontSizeControl />
    </div>
  );
}

export function InToolbar(): JSX.Element {
  return (
    <div style={frame}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.surface,
        }}
      >
        <span style={{ fontSize: 13, color: tokens.color.textMuted }}>Text size</span>
        <FontSizeControl />
      </div>
    </div>
  );
}
