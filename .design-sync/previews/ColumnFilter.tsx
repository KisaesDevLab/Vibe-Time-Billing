// Authored preview — @vibe/ui ColumnFilter
import { ColumnFilter, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

const headerCell = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.text,
  fontSize: 13,
  fontWeight: 600,
};

const STATUS_VALUES = [
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'billed', label: 'Billed' },
  { value: 'archived', label: 'Archived' },
];

const TYPE_VALUES = [
  { value: '1040', label: 'Individual 1040' },
  { value: '1120s', label: '1120-S' },
  { value: '1065', label: '1065' },
  { value: 'audit', label: 'Audit' },
  { value: 'bookkeeping', label: 'Monthly bookkeeping' },
];

export function StatusColumn(): JSX.Element {
  return (
    <div style={frame}>
      <span style={headerCell}>
        Status
        <ColumnFilter
          values={STATUS_VALUES}
          selected={new Set(['in_progress', 'review'])}
          sort={null}
          onApply={() => {}}
          ariaLabel="Filter status"
        />
      </span>
    </div>
  );
}

export function SortedColumn(): JSX.Element {
  return (
    <div style={frame}>
      <span style={headerCell}>
        Engagement type
        <ColumnFilter
          values={TYPE_VALUES}
          selected={new Set()}
          sort="asc"
          onApply={() => {}}
          ariaLabel="Filter engagement type"
        />
      </span>
    </div>
  );
}

export function Inactive(): JSX.Element {
  return (
    <div style={frame}>
      <span style={headerCell}>
        Client
        <ColumnFilter
          values={[
            { value: 'a', label: 'Allen, David' },
            { value: 'b', label: 'Brightway LLC' },
            { value: 'c', label: 'Cedar Holdings' },
          ]}
          selected={new Set()}
          sort={null}
          onApply={() => {}}
          ariaLabel="Filter client"
        />
      </span>
    </div>
  );
}
