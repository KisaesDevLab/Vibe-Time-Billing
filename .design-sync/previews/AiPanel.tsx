// Authored preview — @vibe/ui AiPanel
import { AiPanel, Button, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

export function WithResult(): JSX.Element {
  return (
    <div style={{ ...frame, maxWidth: 460 }}>
      <AiPanel
        title="Pre-bill narrative"
        providerId="claude-opus"
        action={
          <Button size="sm" variant="secondary">
            Regenerate
          </Button>
        }
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: tokens.color.text }}>
          For the period ending May 31, 2026, our team prepared the consolidated 1120-S return and
          supporting K-1 schedules for all four shareholders, reconciled the year-end trial balance,
          and resolved two prior-year depreciation discrepancies. Total recorded time: 18.5 hours.
        </p>
      </AiPanel>
    </div>
  );
}

export function Busy(): JSX.Element {
  return (
    <div style={{ ...frame, maxWidth: 460 }}>
      <AiPanel
        title="Time-entry suggestions"
        providerId="ollama · qwen3"
        busy
        action={
          <Button size="sm" variant="secondary" disabled>
            Generate
          </Button>
        }
      />
    </div>
  );
}

export function ErrorState(): JSX.Element {
  return (
    <div style={{ ...frame, maxWidth: 460 }}>
      <AiPanel
        title="Engagement letter draft"
        providerId="claude-sonnet"
        error="AI budget cap reached for this month (100% of $200). Increase the cap in Admin → AI to continue."
        action={
          <Button size="sm" variant="secondary">
            Retry
          </Button>
        }
      />
    </div>
  );
}
