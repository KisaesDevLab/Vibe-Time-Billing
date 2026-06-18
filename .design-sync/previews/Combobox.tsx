// Authored preview — @vibe/ui Combobox
import { Combobox, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
  width: 320,
};

const label = {
  display: 'block',
  marginBottom: 6,
  fontSize: 12,
  color: tokens.color.textMuted,
};

const WORK_CODES = [
  { value: 'wc-100', label: '100 — Tax preparation', description: 'Billable' },
  { value: 'wc-110', label: '110 — Tax review', description: 'Billable' },
  { value: 'wc-200', label: '200 — Bookkeeping', description: 'Billable' },
  { value: 'wc-300', label: '300 — Advisory', description: 'Billable' },
  { value: 'wc-900', label: '900 — Admin', description: 'Non-billable' },
];

const CLIENTS = [
  { value: 'c-1', label: 'Allen, David' },
  { value: 'c-2', label: 'Brightway LLC' },
  { value: 'c-3', label: 'Cedar Holdings, Inc.' },
  { value: 'c-4', label: 'Delta Manufacturing Co.' },
];

const STAFF = [
  { value: 's-1', label: 'K. Walker, CPA' },
  { value: 's-2', label: 'J. Mendez, Sr. Associate' },
  { value: 's-3', label: 'P. Okafor, Staff' },
  { value: 's-4', label: 'L. Tran (inactive)', disabled: true },
];

export function WorkCode(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>Work code</label>
      <Combobox options={WORK_CODES} value="wc-110" onChange={() => {}} />
    </div>
  );
}

export function Placeholder(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>Client</label>
      <Combobox options={CLIENTS} value="" onChange={() => {}} placeholder="Search clients…" />
    </div>
  );
}

export function Clearable(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>Assigned staff</label>
      <Combobox options={STAFF} value="s-1" onChange={() => {}} clearable />
    </div>
  );
}

export function Small(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>Engagement filter</label>
      <Combobox options={CLIENTS} value="c-2" onChange={() => {}} size="sm" />
    </div>
  );
}

export function Disabled(): JSX.Element {
  return (
    <div style={frame}>
      <label style={label}>Work code (locked)</label>
      <Combobox options={WORK_CODES} value="wc-100" onChange={() => {}} disabled />
    </div>
  );
}
