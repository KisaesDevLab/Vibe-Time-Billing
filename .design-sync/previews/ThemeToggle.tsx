// Authored preview — @vibe/ui ThemeToggle
// NOTE: ThemeToggle calls useTheme(), which reads/writes
// document.documentElement.dataset.theme + localStorage. It needs no
// provider (the hook is self-contained), so it renders standalone here —
// it simply reflects the current <html data-theme> (dark by default).
import { ThemeToggle, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

export function Standalone(): JSX.Element {
  return (
    <div style={frame}>
      <ThemeToggle />
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
        <span style={{ fontSize: 13, color: tokens.color.textMuted }}>Appearance</span>
        <ThemeToggle />
      </div>
    </div>
  );
}
