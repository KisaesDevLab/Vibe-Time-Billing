// Authored preview — @vibe/ui Tabs
import { Tabs, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
  width: 560,
};

const panel = {
  color: tokens.color.text,
  fontSize: 14,
};

const muted = { color: tokens.color.textMuted, fontSize: 13 };

export function ClientTabs(): JSX.Element {
  return (
    <div style={frame}>
      <Tabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'engagements', label: 'Engagements', badge: 4 },
          { key: 'invoices', label: 'Invoices', badge: 2 },
          { key: 'documents', label: 'Documents' },
        ]}
        active="overview"
        onChange={() => {}}
      />
      <div style={panel}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Cedar Holdings, Inc.</h3>
        <p style={muted}>Open WIP $4,820 · Last invoice 05/30/2026 · Net-30</p>
      </div>
    </div>
  );
}

export function BillingTabs(): JSX.Element {
  return (
    <div style={frame}>
      <Tabs
        tabs={[
          { key: 'time', label: 'Time entries' },
          { key: 'prebill', label: 'Pre-bill', badge: 7 },
          { key: 'adjust', label: 'Adjustments' },
          { key: 'invoice', label: 'Invoice' },
        ]}
        active="prebill"
        onChange={() => {}}
      />
      <div style={panel}>
        <p style={{ margin: 0 }}>7 entries ready to bill — $2,310 WIP across 3 timekeepers.</p>
      </div>
    </div>
  );
}

export function TwoTabs(): JSX.Element {
  return (
    <div style={frame}>
      <Tabs
        tabs={[
          { key: 'active', label: 'Active' },
          { key: 'archived', label: 'Archived' },
        ]}
        active="active"
        onChange={() => {}}
      />
      <div style={panel}>
        <p style={{ margin: 0 }}>32 active engagements.</p>
      </div>
    </div>
  );
}
