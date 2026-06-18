// Authored preview — @vibe/ui AppShell
import { AppShell, Button, Pill, ThemeToggle, tokens, type NavItem } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  fontFamily: tokens.font.body,
  minHeight: 520,
};

const staffNav: NavItem[] = [
  { label: 'Dashboard', href: '#', icon: '◧', section: 'Practice' },
  { label: 'Clients', href: '#', icon: '◍' },
  { label: 'Engagements', href: '#', icon: '◆', active: true },
  { label: 'Time entries', href: '#', icon: '◷' },
  { label: 'Pre-bills', href: '#', icon: '$', section: 'Billing' },
  { label: 'Invoices', href: '#', icon: '▤' },
  { label: 'Payments', href: '#', icon: '✓' },
  { label: 'Reports', href: '#', icon: '◔', section: 'Insights' },
  { label: 'Admin', href: '#', icon: '⚙', section: '' },
];

function PageBody(): JSX.Element {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, color: tokens.color.text }}>Engagements</h1>
        <Pill tone="accent">142 active</Pill>
        <span style={{ flex: 1 }} />
        <Button size="sm">New engagement</Button>
      </div>
      <div
        style={{
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.surface,
          overflow: 'hidden',
        }}
      >
        {[
          ['Hartwell Manufacturing LLC', '1120-S — FY2025', '$12,480 WIP'],
          ['Delgado Family Trust', '1041 — FY2025', '$3,250 WIP'],
          ['Northgate Bakery Inc.', 'Monthly Bookkeeping', '$1,150 WIP'],
        ].map(([client, eng, wip], i) => (
          <div
            key={client}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderTop: i === 0 ? 'none' : `1px solid ${tokens.color.border}`,
              fontSize: 13,
              color: tokens.color.text,
            }}
          >
            <span style={{ fontWeight: 600 }}>{client}</span>
            <span style={{ color: tokens.color.textMuted }}>{eng}</span>
            <span>{wip}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StaffShell(): JSX.Element {
  return (
    <div style={frame}>
      <AppShell
        brand="Vibe T&B"
        realmBadge={<Pill tone="neutral">Staff</Pill>}
        nav={staffNav}
        trailing={<ThemeToggle />}
      >
        <PageBody />
      </AppShell>
    </div>
  );
}
