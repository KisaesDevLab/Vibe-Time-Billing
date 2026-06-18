// Authored preview — @vibe/ui EmptyState
import { EmptyState, Button, Card, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

export function WithCta(): JSX.Element {
  return (
    <div style={frame}>
      <Card style={{ maxWidth: 520 }}>
        <EmptyState
          icon="🧾"
          title="No unbilled time yet"
          body="Time entries appear here once timekeepers log work against this engagement. Start by recording your first entry."
          cta={<Button>Log time entry</Button>}
        />
      </Card>
    </div>
  );
}

export function NoIcon(): JSX.Element {
  return (
    <div style={frame}>
      <Card style={{ maxWidth: 520 }}>
        <EmptyState
          title="No overdue invoices"
          body="Every invoice in this client's account is paid or within terms. Nice work."
        />
      </Card>
    </div>
  );
}

export function SearchEmpty(): JSX.Element {
  return (
    <div style={frame}>
      <Card style={{ maxWidth: 520 }}>
        <EmptyState
          icon="🔍"
          title="No clients match “Hartwel”"
          body="Check the spelling or search by EIN instead. You can also clear the filter to see all 312 active clients."
          cta={<Button variant="secondary">Clear filters</Button>}
        />
      </Card>
    </div>
  );
}
