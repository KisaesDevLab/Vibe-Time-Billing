// Authored preview — @vibe/ui MultiCombobox
import { MultiCombobox, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
  width: 360,
};

const label = {
  display: 'block',
  marginBottom: 6,
  fontSize: 12,
  color: tokens.color.textMuted,
};

const WORK_CODES = [
  { value: 'wc-100', label: 'Tax prep' },
  { value: 'wc-110', label: 'Tax review' },
  { value: 'wc-200', label: 'Bookkeeping' },
  { value: 'wc-300', label: 'Advisory' },
  { value: 'wc-400', label: 'Payroll' },
  { value: 'wc-500', label: 'Audit' },
  { value: 'wc-900', label: 'Admin' },
];

const STAFF = [
  { value: 's-1', label: 'K. Walker' },
  { value: 's-2', label: 'J. Mendez' },
  { value: 's-3', label: 'P. Okafor' },
  { value: 's-4', label: 'A. Singh' },
];

export function InScopeCodes(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>In-scope work codes</label>
      <MultiCombobox
        options={WORK_CODES}
        selected={['wc-100', 'wc-110', 'wc-200']}
        onChange={() => {}}
      />
    </div>
  );
}

export function Placeholder(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>Assign timekeepers</label>
      <MultiCombobox
        options={STAFF}
        selected={[]}
        onChange={() => {}}
        placeholder="Select staff…"
      />
    </div>
  );
}

export function Overflow(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>Billable codes (chip limit)</label>
      <MultiCombobox
        options={WORK_CODES}
        selected={['wc-100', 'wc-110', 'wc-200', 'wc-300', 'wc-400', 'wc-500']}
        onChange={() => {}}
        chipLimit={3}
      />
    </div>
  );
}

export function Small(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>Filter by staff</label>
      <MultiCombobox options={STAFF} selected={['s-1', 's-3']} onChange={() => {}} size="sm" />
    </div>
  );
}
