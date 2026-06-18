// Authored preview — @vibe/ui SectionHeading
import { SectionHeading, Button, Pill, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

export function EyebrowAndAction(): JSX.Element {
  return (
    <div style={{ ...frame, maxWidth: 640 }}>
      <SectionHeading
        eyebrow="Billing"
        title="Open invoices"
        action={
          <Button size="sm" variant="secondary">
            View all
          </Button>
        }
      />
    </div>
  );
}

export function WithDescription(): JSX.Element {
  return (
    <div style={{ ...frame, maxWidth: 640 }}>
      <SectionHeading
        eyebrow="Engagement"
        title="Write-up / write-down adjustments"
        description="Adjustments above $1,000 route to the partner approval queue before they post to WIP."
        action={<Pill tone="warning">2 pending</Pill>}
      />
    </div>
  );
}

export function TitleOnly(): JSX.Element {
  return (
    <div style={{ ...frame, maxWidth: 640 }}>
      <SectionHeading title="Recent time entries" />
    </div>
  );
}
