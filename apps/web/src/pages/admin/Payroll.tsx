// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Payroll (0226). Firm payroll settings (workweek, period
// frequency + anchor, comp multiplier), accrual policy CRUD with tenure
// tiers, the per-employee policy assignment matrix, and the work-code
// payroll-category editor.

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, ScrollX, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface PolicyTier {
  id?: string;
  minYearsService: number;
  rateHours: string | number;
}

interface Policy {
  id: string;
  bank: 'PTO' | 'SICK' | 'COMP';
  name: string;
  method: 'FIXED_PER_PERIOD' | 'PER_HOURS_WORKED' | 'ANNUAL_GRANT';
  hoursPerPeriod: string | null;
  earnHours: string | null;
  perWorkedHours: string | null;
  annualGrantHours: string | null;
  annualGrantTiming: 'CALENDAR_YEAR' | 'ANNIVERSARY' | null;
  accrualWaitingDays: number;
  usageWaitingDays: number;
  maxBalanceHours: string | null;
  carryoverCapHours: string | null;
  tiers: PolicyTier[];
}

interface Assignment {
  id: string;
  appUserId: string;
  policyId: string;
  bank: string;
  policyName: string;
}

interface FirmUser {
  id: string;
  fullName: string;
}

interface WorkCode {
  id: string;
  key: string;
  name: string;
  payrollCategory: string;
}

interface PayrollSettings {
  payrollEnabled: boolean;
  payrollWorkweekStartDay: number;
  payrollPeriodFrequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY';
  payrollPeriodAnchorDate: string | null;
  payrollHolidayDefaultHours: string;
  payrollCompOtMultiplier: string;
}

const BANKS = ['PTO', 'SICK', 'COMP'] as const;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CATEGORIES = ['REGULAR', 'PTO', 'SICK', 'HOLIDAY', 'COMP_USED', 'UNPAID'] as const;

const selectStyle = {
  padding: '8px 10px',
  fontSize: 13,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.bg,
  color: tokens.color.text,
} as const;

function methodSummary(p: Policy): string {
  switch (p.method) {
    case 'FIXED_PER_PERIOD':
      return `${Number(p.hoursPerPeriod ?? 0)}h / pay period`;
    case 'PER_HOURS_WORKED':
      return `${Number(p.earnHours ?? 0)}h per ${Number(p.perWorkedHours ?? 0)}h worked`;
    case 'ANNUAL_GRANT':
      return `${Number(p.annualGrantHours ?? 0)}h / year (${
        p.annualGrantTiming === 'ANNIVERSARY' ? 'anniversary' : 'Jan 1'
      })`;
  }
}

export function PayrollAdminPage(): JSX.Element {
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [users, setUsers] = useState<FirmUser[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // New-policy form state.
  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [pf, setPf] = useState({
    bank: 'PTO' as (typeof BANKS)[number],
    name: '',
    method: 'FIXED_PER_PERIOD' as Policy['method'],
    rate: '',
    perWorked: '',
    grantTiming: 'CALENDAR_YEAR' as 'CALENDAR_YEAR' | 'ANNIVERSARY',
    accrualWaitingDays: '0',
    usageWaitingDays: '0',
    maxBalance: '',
    carryoverCap: '',
  });

  const load = useCallback(async (): Promise<void> => {
    try {
      const [fs, pol, asg, us, wc] = await Promise.all([
        api<{ settings: PayrollSettings | null }>('/api/staff/admin/firm-settings'),
        api<{ items: Policy[] }>('/api/staff/payroll/policies'),
        api<{ items: Assignment[] }>('/api/staff/payroll/assignments'),
        api<{ items: FirmUser[] }>('/api/staff/firm-users'),
        api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes'),
      ]);
      setSettings(fs.settings);
      setPolicies(pol.items ?? []);
      setAssignments(asg.items ?? []);
      setUsers(us.items ?? []);
      setWorkCodes((wc.items ?? []).filter((w) => w.payrollCategory));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings(patch: Record<string, unknown>): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await api('/api/staff/admin/firm-settings', { method: 'PATCH', body: JSON.stringify(patch) });
      setNotice('Settings saved.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function createPolicy(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const rate = Number(pf.rate);
    const body: Record<string, unknown> = {
      bank: pf.bank,
      name: pf.name,
      method: pf.method,
      accrualWaitingDays: Number(pf.accrualWaitingDays) || 0,
      usageWaitingDays: Number(pf.usageWaitingDays) || 0,
      maxBalanceHours: pf.maxBalance ? Number(pf.maxBalance) : null,
      carryoverCapHours: pf.carryoverCap ? Number(pf.carryoverCap) : null,
    };
    if (pf.method === 'FIXED_PER_PERIOD') body['hoursPerPeriod'] = rate;
    if (pf.method === 'PER_HOURS_WORKED') {
      body['earnHours'] = rate;
      body['perWorkedHours'] = Number(pf.perWorked);
    }
    if (pf.method === 'ANNUAL_GRANT') {
      body['annualGrantHours'] = rate;
      body['annualGrantTiming'] = pf.grantTiming;
    }
    try {
      await api('/api/staff/payroll/policies', { method: 'POST', body: JSON.stringify(body) });
      setShowPolicyForm(false);
      setPf({ ...pf, name: '', rate: '', perWorked: '', maxBalance: '', carryoverCap: '' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function archivePolicy(id: string): Promise<void> {
    try {
      await api(`/api/staff/payroll/policies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ARCHIVED' }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function editTiers(policy: Policy): Promise<void> {
    const current = policy.tiers
      .map((t) => `${t.minYearsService}:${Number(t.rateHours)}`)
      .join(', ');
    const input = window.prompt(
      'Tenure tiers as "minYears:hours" pairs, comma-separated (e.g. "2:5, 5:6.5"). Empty clears.',
      current,
    );
    if (input == null) return;
    const tiers = input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const [y, h] = pair.split(':');
        return { minYearsService: Number(y), rateHours: Number(h) };
      })
      .filter((t) => Number.isFinite(t.minYearsService) && t.rateHours > 0);
    try {
      await api(`/api/staff/payroll/policies/${policy.id}/tiers`, {
        method: 'PUT',
        body: JSON.stringify({ tiers }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function assign(appUserId: string, policyId: string): Promise<void> {
    setError(null);
    try {
      if (policyId === '') return;
      await api('/api/staff/payroll/assignments', {
        method: 'POST',
        body: JSON.stringify({ appUserId, policyId }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function unassign(assignmentId: string): Promise<void> {
    try {
      await api(`/api/staff/payroll/assignments/${assignmentId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function setCategory(workCodeId: string, category: string): Promise<void> {
    try {
      await api(`/api/staff/taxonomy/work-codes/${workCodeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ payrollCategory: category }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  const activePolicies = policies;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      {notice && <p style={{ color: tokens.color.accent, fontSize: 13 }}>{notice}</p>}

      <Card title="Payroll settings">
        {settings ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={settings.payrollEnabled}
                onChange={(e) => void saveSettings({ payrollEnabled: e.target.checked })}
              />
              Payroll timekeeping enabled
            </label>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 12,
                alignItems: 'end',
              }}
            >
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                Workweek starts
                <select
                  value={settings.payrollWorkweekStartDay}
                  onChange={(e) =>
                    void saveSettings({ payrollWorkweekStartDay: Number(e.target.value) })
                  }
                  style={selectStyle}
                >
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                Pay period
                <select
                  value={settings.payrollPeriodFrequency}
                  onChange={(e) => void saveSettings({ payrollPeriodFrequency: e.target.value })}
                  style={selectStyle}
                >
                  <option value="WEEKLY">Weekly</option>
                  <option value="BIWEEKLY">Biweekly</option>
                  <option value="SEMI_MONTHLY">Semi-monthly (1–15 / 16–EOM)</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </label>
              {(settings.payrollPeriodFrequency === 'WEEKLY' ||
                settings.payrollPeriodFrequency === 'BIWEEKLY') && (
                <Input
                  label="Anchor date (a period start)"
                  type="date"
                  value={settings.payrollPeriodAnchorDate ?? ''}
                  onChange={(e) =>
                    void saveSettings({ payrollPeriodAnchorDate: e.target.value || null })
                  }
                />
              )}
              <Input
                label="Comp multiplier (× OT hours)"
                type="number"
                step="0.25"
                min="1"
                max="3"
                defaultValue={Number(settings.payrollCompOtMultiplier)}
                onBlur={(e) =>
                  void saveSettings({ payrollCompOtMultiplier: Number(e.target.value) || 1.5 })
                }
              />
            </div>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              Overtime is computed weekly over 40 hours for non-exempt staff (exempt/full-time flags
              live on each user&apos;s Payroll tab). Pay periods are generated automatically; review
              and lock them on the Payroll review page.
            </p>
          </div>
        ) : (
          <p style={{ fontSize: 13 }}>Loading…</p>
        )}
      </Card>

      <Card
        title="Accrual policies"
        action={
          <Button size="sm" variant="secondary" onClick={() => setShowPolicyForm((v) => !v)}>
            {showPolicyForm ? 'Close' : 'New policy'}
          </Button>
        }
      >
        {showPolicyForm && (
          <form
            onSubmit={createPolicy}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
              alignItems: 'end',
              marginBottom: 16,
            }}
          >
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              Bank
              <select
                value={pf.bank}
                onChange={(e) => setPf({ ...pf, bank: e.target.value as (typeof BANKS)[number] })}
                style={selectStyle}
              >
                {BANKS.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <Input
              label="Name"
              value={pf.name}
              onChange={(e) => setPf({ ...pf, name: e.target.value })}
              required
            />
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              Method
              <select
                value={pf.method}
                onChange={(e) => setPf({ ...pf, method: e.target.value as Policy['method'] })}
                style={selectStyle}
              >
                <option value="FIXED_PER_PERIOD">Fixed per pay period</option>
                <option value="PER_HOURS_WORKED">Per hours worked</option>
                <option value="ANNUAL_GRANT">Annual grant</option>
              </select>
            </label>
            <Input
              label={
                pf.method === 'FIXED_PER_PERIOD'
                  ? 'Hours / period'
                  : pf.method === 'PER_HOURS_WORKED'
                    ? 'Hours earned'
                    : 'Hours / year'
              }
              type="number"
              step="0.01"
              min="0.01"
              value={pf.rate}
              onChange={(e) => setPf({ ...pf, rate: e.target.value })}
              required
            />
            {pf.method === 'PER_HOURS_WORKED' && (
              <Input
                label="Per hours worked"
                type="number"
                step="1"
                min="1"
                value={pf.perWorked}
                onChange={(e) => setPf({ ...pf, perWorked: e.target.value })}
                required
              />
            )}
            {pf.method === 'ANNUAL_GRANT' && (
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                Grant timing
                <select
                  value={pf.grantTiming}
                  onChange={(e) =>
                    setPf({ ...pf, grantTiming: e.target.value as typeof pf.grantTiming })
                  }
                  style={selectStyle}
                >
                  <option value="CALENDAR_YEAR">Jan 1</option>
                  <option value="ANNIVERSARY">Hire anniversary</option>
                </select>
              </label>
            )}
            <Input
              label="Accrual waiting days"
              type="number"
              min="0"
              value={pf.accrualWaitingDays}
              onChange={(e) => setPf({ ...pf, accrualWaitingDays: e.target.value })}
            />
            <Input
              label="Usage waiting days"
              type="number"
              min="0"
              value={pf.usageWaitingDays}
              onChange={(e) => setPf({ ...pf, usageWaitingDays: e.target.value })}
            />
            <Input
              label="Max balance (blank = none)"
              type="number"
              step="0.5"
              min="0"
              value={pf.maxBalance}
              onChange={(e) => setPf({ ...pf, maxBalance: e.target.value })}
            />
            <Input
              label="Carryover cap (blank = unlimited)"
              type="number"
              step="0.5"
              min="0"
              value={pf.carryoverCap}
              onChange={(e) => setPf({ ...pf, carryoverCap: e.target.value })}
            />
            <Button type="submit">Create</Button>
          </form>
        )}
        <Table<Policy>
          columns={[
            { key: 'bank', header: 'Bank', render: (p) => <Pill tone="accent">{p.bank}</Pill> },
            { key: 'name', header: 'Name', render: (p) => p.name },
            { key: 'method', header: 'Accrues', render: (p) => methodSummary(p) },
            {
              key: 'caps',
              header: 'Caps',
              render: (p) =>
                [
                  p.maxBalanceHours ? `max ${Number(p.maxBalanceHours)}h` : null,
                  p.carryoverCapHours != null ? `carryover ${Number(p.carryoverCapHours)}h` : null,
                  p.accrualWaitingDays ? `wait ${p.accrualWaitingDays}d` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—',
            },
            {
              key: 'tiers',
              header: 'Tenure tiers',
              render: (p) =>
                p.tiers.length > 0
                  ? p.tiers.map((t) => `${t.minYearsService}y → ${Number(t.rateHours)}h`).join(', ')
                  : '—',
            },
            {
              key: 'actions',
              header: '',
              render: (p) => (
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button size="sm" variant="secondary" onClick={() => void editTiers(p)}>
                    Tiers
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void archivePolicy(p.id)}>
                    Archive
                  </Button>
                </div>
              ),
            },
          ]}
          rows={activePolicies}
          rowKey={(p) => p.id}
          empty="No accrual policies yet — create one, then assign it to staff below."
        />
      </Card>

      <Card title="Policy assignments">
        <ScrollX>
          <Table<FirmUser>
            columns={[
              { key: 'name', header: 'Staff', render: (u) => u.fullName },
              ...BANKS.map((bank) => ({
                key: bank,
                header: bank,
                render: (u: FirmUser) => {
                  const current = assignments.find((a) => a.appUserId === u.id && a.bank === bank);
                  const options = activePolicies.filter((p) => p.bank === bank);
                  return (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <select
                        value={current?.policyId ?? ''}
                        onChange={(e) => void assign(u.id, e.target.value)}
                        style={{ ...selectStyle, padding: '4px 6px', fontSize: 12 }}
                      >
                        <option value="">— none —</option>
                        {options.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      {current && (
                        <Button size="sm" variant="ghost" onClick={() => void unassign(current.id)}>
                          ✕
                        </Button>
                      )}
                    </div>
                  );
                },
              })),
            ]}
            rows={users}
            rowKey={(u) => u.id}
            empty="No active staff."
          />
        </ScrollX>
      </Card>

      <Card title="Work-code payroll categories">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          A code&apos;s category decides which payroll bucket its hours land in. PTO / Sick / Comp
          used codes also deduct from that balance when time is logged.
        </p>
        <Table<WorkCode>
          columns={[
            { key: 'key', header: 'Key', render: (w) => w.key },
            { key: 'name', header: 'Name', render: (w) => w.name },
            {
              key: 'category',
              header: 'Payroll category',
              render: (w) => (
                <select
                  value={w.payrollCategory}
                  onChange={(e) => void setCategory(w.id, e.target.value)}
                  style={{ ...selectStyle, padding: '4px 6px', fontSize: 12 }}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              ),
            },
          ]}
          rows={workCodes}
          rowKey={(w) => w.id}
          empty="No work codes."
        />
      </Card>
    </div>
  );
}
