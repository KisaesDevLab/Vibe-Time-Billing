// Authored preview — @vibe/ui Sparkline
import { Sparkline, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

// Monthly collections, Jul 2025 → Jun 2026 ($000s).
const collections = [62, 58, 71, 69, 80, 74, 88, 91, 84, 96, 102, 110];
// Realization rate trending down (%) — clamp Y to [0,1].
const realization = [0.94, 0.93, 0.91, 0.92, 0.89, 0.87, 0.85, 0.84];

const cell = (label: string, value: string, node: JSX.Element) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 14px',
      border: `1px solid ${tokens.color.border}`,
      borderRadius: tokens.radius.md,
      background: tokens.color.surface,
    }}
  >
    <div style={{ minWidth: 150 }}>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: tokens.color.text }}>{value}</div>
    </div>
    {node}
  </div>
);

export function CollectionsUp(): JSX.Element {
  return (
    <div style={frame}>
      {cell(
        'Collections (12 mo)',
        '$110.0k',
        <Sparkline
          values={collections}
          width={120}
          height={32}
          tone="success"
          ariaLabel="Monthly collections trending up"
        />,
      )}
    </div>
  );
}

export function RealizationDown(): JSX.Element {
  return (
    <div style={frame}>
      {cell(
        'Realization (8 mo)',
        '84%',
        <Sparkline
          values={realization}
          width={120}
          height={32}
          tone="warning"
          yMin={0}
          yMax={1}
          ariaLabel="Realization rate trending down"
        />,
      )}
    </div>
  );
}

export function Inline(): JSX.Element {
  return (
    <div style={{ ...frame, fontSize: 14, color: tokens.color.text }}>
      WIP this quarter{' '}
      <Sparkline values={[12, 14, 11, 18, 16, 22, 24]} tone="accent" ariaLabel="WIP trend" />{' '}
      <strong>$48.2k</strong>
    </div>
  );
}
