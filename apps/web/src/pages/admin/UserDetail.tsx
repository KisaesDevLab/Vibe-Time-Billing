// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin user detail page. Three tabs match the CCH-style staff record:
//   Main         — first/middle/last, title, salutation, hired/left, status
//   Contact Info — phones, address, email
//   Rates        — effective-dated snapshots (append-only); each snapshot
//                  has one cost rate and one billing rate per rate code.
//
// Roles / Authentication / Lifecycle live below the tabs since they're
// orthogonal to the tab content.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button, Card, Combobox, Input, Pill, Table, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';

interface User {
  id: string;
  email: string;
  fullName: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  title: string | null;
  salutation: string | null;
  businessPhone: string | null;
  homePhone: string | null;
  faxPhone: string | null;
  mobilePhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  hiredDate: string | null;
  leftDate: string | null;
  defaultOfficeId: string | null;
  status: string;
  totpEnrolledAt: string | null;
  standardHoursPerWeek: string;
  billableTargetHoursPerMonth: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface RoleAssignment {
  roleId: string;
  roleSlug: string;
  roleName: string;
}

interface RoleOption {
  id: string;
  slug: string;
  name: string;
}

interface Office {
  id: string;
  name: string;
}

interface RateCode {
  id: string;
  code: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
}

interface SnapshotEntry {
  rateCodeId: string;
  billRateCents: number;
}

interface Snapshot {
  id: string;
  effectiveDate: string;
  costRateCents: number | null;
  createdAt: string;
  entries: SnapshotEntry[];
}

type Tab = 'main' | 'contact' | 'rates';

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
  width: '100%',
};

function dollars(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export function UserDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('main');
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  const [allRoles, setAllRoles] = useState<RoleOption[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [rateCodes, setRateCodes] = useState<RateCode[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [editingProfile, setEditingProfile] = useState(false);
  const [draft, setDraft] = useState<Partial<User>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-snapshot draft state.
  const [addingSnap, setAddingSnap] = useState(false);
  const [snapDate, setSnapDate] = useState('');
  const [snapCostDollars, setSnapCostDollars] = useState('');
  const [snapEntryDollars, setSnapEntryDollars] = useState<Record<string, string>>({});

  async function load(): Promise<void> {
    if (!id) return;
    try {
      const [u, r, ar, o] = await Promise.all([
        api<{ user: User }>(`/api/staff/admin/users/${id}`),
        api<{ roles: RoleAssignment[] }>(`/api/staff/admin/users/${id}/roles`),
        api<{ roles: RoleOption[] }>(`/api/staff/admin/roles`),
        api<{ offices: Office[] }>('/api/staff/admin/offices'),
      ]);
      setUser(u.user);
      setRoles(r.roles ?? []);
      setAllRoles(ar.roles ?? []);
      setOffices(o.offices ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  async function loadRates(): Promise<void> {
    if (!id) return;
    try {
      const r = await api<{ codes: RateCode[]; snapshots: Snapshot[] }>(
        `/api/staff/admin/users/${id}/rate-snapshots`,
      );
      setRateCodes(r.codes ?? []);
      setSnapshots(r.snapshots ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'rates_load_failed');
    }
  }

  useEffect(() => {
    void load();
    void loadRates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function saveProfile(): Promise<void> {
    if (!id) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      setEditingProfile(false);
      setStatus('Profile saved.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function resetTotp(): Promise<void> {
    if (!id) return;
    if (!confirm('Reset TOTP? The user must re-enroll at next sign-in.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}/reset-totp`, { method: 'POST' });
      setStatus('TOTP reset. User must re-enroll next sign-in.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'reset_failed');
    } finally {
      setBusy(false);
    }
  }

  async function archive(): Promise<void> {
    if (!id) return;
    if (!confirm('Archive this user? They will be unable to sign in.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}/archive`, { method: 'PATCH' });
      setStatus('User archived.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    } finally {
      setBusy(false);
    }
  }

  async function assignRole(roleId: string): Promise<void> {
    if (!id || !roleId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleId }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'assign_failed');
    } finally {
      setBusy(false);
    }
  }

  function startNewSnapshot(): void {
    const latest = snapshots[0];
    setSnapDate(new Date().toISOString().slice(0, 10));
    setSnapCostDollars(
      latest?.costRateCents != null ? (latest.costRateCents / 100).toFixed(2) : '',
    );
    const seeded: Record<string, string> = {};
    for (const c of rateCodes.filter((rc) => rc.active)) {
      const prior = latest?.entries.find((e) => e.rateCodeId === c.id);
      seeded[c.id] = prior ? (prior.billRateCents / 100).toFixed(2) : '';
    }
    setSnapEntryDollars(seeded);
    setAddingSnap(true);
  }

  async function saveNewSnapshot(): Promise<void> {
    if (!id) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const entries: SnapshotEntry[] = [];
      for (const [rateCodeId, val] of Object.entries(snapEntryDollars)) {
        if (val.trim() === '') continue;
        const dollarsValue = parseFloat(val);
        if (!Number.isFinite(dollarsValue) || dollarsValue < 0) continue;
        entries.push({ rateCodeId, billRateCents: Math.round(dollarsValue * 100) });
      }
      if (entries.length === 0) {
        setError('Add at least one billing rate.');
        setBusy(false);
        return;
      }
      const standardId = rateCodes.find((c) => c.code === 'StandardRate')?.id;
      if (!standardId || !entries.some((e) => e.rateCodeId === standardId)) {
        setError('A StandardRate entry is required on every snapshot.');
        setBusy(false);
        return;
      }
      const costCents = snapCostDollars.trim()
        ? Math.round(parseFloat(snapCostDollars) * 100)
        : null;
      await api(`/api/staff/admin/users/${id}/rate-snapshots`, {
        method: 'POST',
        body: JSON.stringify({
          effectiveDate: snapDate,
          costRateCents: costCents,
          entries,
        }),
      });
      setAddingSnap(false);
      setSnapEntryDollars({});
      setSnapCostDollars('');
      setSnapDate('');
      setStatus('Snapshot added.');
      await loadRates();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'snapshot_save_failed');
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <Card title="User">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>{error ?? 'Loading…'}</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      {status && (
        <p style={{ color: tokens.color.success, fontSize: 12 }} role="status">
          {status}
        </p>
      )}
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
          {error}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{user.fullName}</span>
          <Pill tone={user.status === 'ACTIVE' ? 'success' : 'warning'}>{user.status}</Pill>
        </h1>
      </div>

      <div
        role="tablist"
        aria-label="User tabs"
        style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${tokens.color.border}` }}
      >
        <TabButton current={tab} value="main" onSelect={setTab}>
          Main
        </TabButton>
        <TabButton current={tab} value="contact" onSelect={setTab}>
          Contact Info
        </TabButton>
        <TabButton current={tab} value="rates" onSelect={setTab}>
          Rates
        </TabButton>
      </div>

      {tab === 'main' && (
        <MainTab
          user={user}
          draft={draft}
          setDraft={setDraft}
          editing={editingProfile}
          setEditing={setEditingProfile}
          onSave={() => void saveProfile()}
          busy={busy}
          offices={offices}
        />
      )}
      {tab === 'contact' && (
        <ContactTab
          user={user}
          draft={draft}
          setDraft={setDraft}
          editing={editingProfile}
          setEditing={setEditingProfile}
          onSave={() => void saveProfile()}
          busy={busy}
        />
      )}
      {tab === 'rates' && (
        <RatesTab
          codes={rateCodes}
          snapshots={snapshots}
          adding={addingSnap}
          startNew={startNewSnapshot}
          cancelNew={() => setAddingSnap(false)}
          saveNew={() => void saveNewSnapshot()}
          snapDate={snapDate}
          setSnapDate={setSnapDate}
          snapCostDollars={snapCostDollars}
          setSnapCostDollars={setSnapCostDollars}
          snapEntryDollars={snapEntryDollars}
          setSnapEntryDollars={setSnapEntryDollars}
          busy={busy}
        />
      )}

      <Card
        title="Roles"
        action={
          <div style={{ width: 220 }}>
            <Combobox
              ariaLabel="Assign role"
              disabled={busy}
              value=""
              onChange={(val) => {
                if (val) void assignRole(val);
              }}
              options={allRoles
                .filter((r) => !roles.some((cur) => cur.roleId === r.id))
                .map<ComboboxOption>((r) => ({ value: r.id, label: r.name }))}
              placeholder="+ Assign role…"
              size="sm"
            />
          </div>
        }
      >
        {roles.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No roles assigned. User has read-only baseline access until at least one role is
            attached.
          </p>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {roles.map((r) => (
              <Pill key={r.roleId} tone="accent">
                {r.roleName} <code style={{ fontSize: 10, opacity: 0.6 }}>{r.roleSlug}</code>
              </Pill>
            ))}
          </div>
        )}
      </Card>

      <Card title="Authentication">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 13 }}>
              TOTP:{' '}
              {user.totpEnrolledAt ? (
                <Pill tone="success">enrolled</Pill>
              ) : (
                <Pill tone="warning">not enrolled</Pill>
              )}
            </div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
              {user.totpEnrolledAt
                ? `Enrolled ${new Date(user.totpEnrolledAt).toLocaleDateString()}`
                : 'Required at first sign-in (locked decision #5).'}
            </div>
          </div>
          {user.totpEnrolledAt && (
            <Button size="sm" variant="secondary" onClick={() => void resetTotp()} disabled={busy}>
              Reset TOTP
            </Button>
          )}
        </div>
      </Card>

      <Card title="Lifecycle">
        <div style={{ display: 'flex', gap: 8 }}>
          {user.status === 'ACTIVE' && (
            <Button variant="secondary" onClick={() => void archive()} disabled={busy}>
              Archive
            </Button>
          )}
          <span style={{ fontSize: 12, color: tokens.color.textMuted, alignSelf: 'center' }}>
            Created {new Date(user.createdAt).toLocaleDateString()}
          </span>
        </div>
      </Card>
    </div>
  );
}

function TabButton({
  current,
  value,
  onSelect,
  children,
}: {
  current: Tab;
  value: Tab;
  onSelect: (v: Tab) => void;
  children: React.ReactNode;
}): JSX.Element {
  const active = current === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(value)}
      style={{
        padding: '8px 16px',
        background: 'transparent',
        color: active ? tokens.color.accent : tokens.color.text,
        border: 'none',
        borderBottom: active ? `2px solid ${tokens.color.accent}` : '2px solid transparent',
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function ProfileEditButtons({
  editing,
  setEditing,
  onSave,
  setDraftReset,
  busy,
}: {
  editing: boolean;
  setEditing: (v: boolean) => void;
  onSave: () => void;
  setDraftReset: () => void;
  busy: boolean;
}): JSX.Element {
  if (editing) {
    return (
      <span style={{ display: 'flex', gap: 6 }}>
        <Button size="sm" onClick={onSave} disabled={busy}>
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(false);
            setDraftReset();
          }}
        >
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
      Edit
    </Button>
  );
}

function MainTab({
  user,
  draft,
  setDraft,
  editing,
  setEditing,
  onSave,
  busy,
  offices,
}: {
  user: User;
  draft: Partial<User>;
  setDraft: (d: Partial<User>) => void;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onSave: () => void;
  busy: boolean;
  offices: Office[];
}): JSX.Element {
  const v = (k: keyof User): string => {
    const d = draft[k];
    if (d !== undefined) return (d as string | null) ?? '';
    return (user[k] as string | null) ?? '';
  };
  return (
    <Card
      title="Identification"
      action={
        <ProfileEditButtons
          editing={editing}
          setEditing={setEditing}
          onSave={onSave}
          setDraftReset={() => setDraft({})}
          busy={busy}
        />
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <Field label="First">
          {editing ? (
            <input
              value={v('firstName')}
              onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
              style={fieldStyle}
            />
          ) : (
            <Plain>{user.firstName}</Plain>
          )}
        </Field>
        <Field label="Middle">
          {editing ? (
            <input
              value={v('middleName')}
              onChange={(e) => setDraft({ ...draft, middleName: e.target.value })}
              style={fieldStyle}
            />
          ) : (
            <Plain>{user.middleName}</Plain>
          )}
        </Field>
        <Field label="Last">
          {editing ? (
            <input
              value={v('lastName')}
              onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
              style={fieldStyle}
            />
          ) : (
            <Plain>{user.lastName}</Plain>
          )}
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
        <Field label="Hired">
          {editing ? (
            <input
              type="date"
              value={v('hiredDate')}
              onChange={(e) => setDraft({ ...draft, hiredDate: e.target.value || null })}
              style={fieldStyle}
            />
          ) : (
            <Plain>{user.hiredDate}</Plain>
          )}
        </Field>
        <Field label="Left">
          {editing ? (
            <input
              type="date"
              value={v('leftDate')}
              onChange={(e) => setDraft({ ...draft, leftDate: e.target.value || null })}
              style={fieldStyle}
            />
          ) : (
            <Plain>{user.leftDate}</Plain>
          )}
        </Field>
        <Field label="Status">
          {editing ? (
            <select
              value={(draft.status as string) ?? user.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              style={fieldStyle}
            >
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          ) : (
            <Plain>{user.status}</Plain>
          )}
        </Field>
        <Field label="Default office">
          {editing ? (
            <Combobox
              ariaLabel="Default office"
              clearable
              value={(draft.defaultOfficeId ?? user.defaultOfficeId ?? '') as string}
              onChange={(val) => setDraft({ ...draft, defaultOfficeId: val || null })}
              options={offices.map<ComboboxOption>((o) => ({ value: o.id, label: o.name }))}
              placeholder="— none —"
            />
          ) : (
            <Plain>{offices.find((o) => o.id === user.defaultOfficeId)?.name ?? null}</Plain>
          )}
        </Field>
        <Field label="Standard hours / week">
          {editing ? (
            <input
              type="number"
              step={0.5}
              value={
                (draft.standardHoursPerWeek as string | undefined) ?? user.standardHoursPerWeek
              }
              onChange={(e) => setDraft({ ...draft, standardHoursPerWeek: e.target.value })}
              style={fieldStyle}
            />
          ) : (
            <Plain>{user.standardHoursPerWeek}</Plain>
          )}
        </Field>
        <Field label="Billable target / month">
          {editing ? (
            <input
              type="number"
              value={
                (draft.billableTargetHoursPerMonth as number | null | undefined) ??
                user.billableTargetHoursPerMonth ??
                ''
              }
              onChange={(e) =>
                setDraft({
                  ...draft,
                  billableTargetHoursPerMonth: e.target.value ? Number(e.target.value) : null,
                })
              }
              placeholder="(inherit firm default)"
              style={fieldStyle}
            />
          ) : (
            <Plain>
              {user.billableTargetHoursPerMonth == null
                ? '(firm default)'
                : String(user.billableTargetHoursPerMonth)}
            </Plain>
          )}
        </Field>
      </div>
    </Card>
  );
}

function ContactTab({
  user,
  draft,
  setDraft,
  editing,
  setEditing,
  onSave,
  busy,
}: {
  user: User;
  draft: Partial<User>;
  setDraft: (d: Partial<User>) => void;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onSave: () => void;
  busy: boolean;
}): JSX.Element {
  const inp = (k: keyof User): React.ReactNode =>
    editing ? (
      <input
        value={(draft[k] as string | null | undefined) ?? (user[k] as string | null) ?? ''}
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value || null } as Partial<User>)}
        style={fieldStyle}
      />
    ) : (
      <Plain>{user[k] as string | null}</Plain>
    );
  return (
    <Card
      title="Contact"
      action={
        <ProfileEditButtons
          editing={editing}
          setEditing={setEditing}
          onSave={onSave}
          setDraftReset={() => setDraft({})}
          busy={busy}
        />
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Email">
            <Plain>{user.email}</Plain>
          </Field>
          <Field label="Title">{inp('title')}</Field>
          <Field label="Salutation">{inp('salutation')}</Field>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Business phone">{inp('businessPhone')}</Field>
          <Field label="Home phone">{inp('homePhone')}</Field>
          <Field label="Mobile phone">{inp('mobilePhone')}</Field>
          <Field label="Fax">{inp('faxPhone')}</Field>
        </div>
      </div>
      <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
        <Field label="Address line 1">{inp('addressLine1')}</Field>
        <Field label="Address line 2">{inp('addressLine2')}</Field>
      </div>
      <div
        style={{
          marginTop: 12,
          display: 'grid',
          gridTemplateColumns: '2fr 100px 100px',
          gap: 12,
        }}
      >
        <Field label="City">{inp('city')}</Field>
        <Field label="State">{inp('state')}</Field>
        <Field label="Zip">{inp('zip')}</Field>
      </div>
    </Card>
  );
}

function RatesTab({
  codes,
  snapshots,
  adding,
  startNew,
  cancelNew,
  saveNew,
  snapDate,
  setSnapDate,
  snapCostDollars,
  setSnapCostDollars,
  snapEntryDollars,
  setSnapEntryDollars,
  busy,
}: {
  codes: RateCode[];
  snapshots: Snapshot[];
  adding: boolean;
  startNew: () => void;
  cancelNew: () => void;
  saveNew: () => void;
  snapDate: string;
  setSnapDate: (v: string) => void;
  snapCostDollars: string;
  setSnapCostDollars: (v: string) => void;
  snapEntryDollars: Record<string, string>;
  setSnapEntryDollars: (v: Record<string, string>) => void;
  busy: boolean;
}): JSX.Element {
  const activeCodes = codes.filter((c) => c.active);
  return (
    <>
      <Card
        title="Effective-dated billing rates"
        action={
          adding ? null : (
            <Button size="sm" onClick={startNew}>
              + New effective period
            </Button>
          )
        }
      >
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0, marginBottom: 12 }}>
          Snapshots are append-only — to change rates, add a new effective period.
          <code>StandardRate</code> is required on every snapshot (it&apos;s the resolver fallback).
        </p>
        {adding && (
          <div
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              padding: 12,
              marginBottom: 16,
              background: tokens.color.surface,
            }}
          >
            <div
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}
            >
              <Input
                label="Effective date"
                type="date"
                value={snapDate}
                onChange={(e) => setSnapDate(e.target.value)}
              />
              <Input
                label="Cost / hr ($)"
                type="number"
                step="0.01"
                value={snapCostDollars}
                onChange={(e) => setSnapCostDollars(e.target.value)}
              />
            </div>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 6 }}>
              Billing rates per code (blank = omit; remove a code from this snapshot)
            </div>
            <Table<RateCode>
              columns={[
                {
                  key: 'code',
                  header: 'Code',
                  render: (c) => (
                    <span>
                      <code>{c.code}</code>
                      {c.code === 'StandardRate' && <Pill tone="neutral">required</Pill>}
                    </span>
                  ),
                },
                {
                  key: 'desc',
                  header: 'Description',
                  render: (c) => (
                    <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                      {c.description ?? '—'}
                    </span>
                  ),
                },
                {
                  key: 'rate',
                  header: '$ / hr',
                  align: 'right',
                  render: (c) => (
                    <Input
                      type="number"
                      step="0.01"
                      value={snapEntryDollars[c.id] ?? ''}
                      onChange={(e) =>
                        setSnapEntryDollars({
                          ...snapEntryDollars,
                          [c.id]: e.target.value,
                        })
                      }
                      style={{ width: 120 }}
                    />
                  ),
                },
              ]}
              rows={activeCodes}
              rowKey={(c) => c.id}
              empty="No rate codes."
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={cancelNew} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={saveNew} disabled={busy || !snapDate}>
                {busy ? 'Saving…' : 'Save snapshot'}
              </Button>
            </div>
          </div>
        )}

        {snapshots.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No snapshots yet. Add the first effective period above.
          </p>
        ) : (
          <Table<Snapshot>
            columns={[
              {
                key: 'effectiveDate',
                header: 'Effective',
                render: (s) => s.effectiveDate,
              },
              {
                key: 'cost',
                header: 'Cost / hr',
                align: 'right',
                render: (s) => dollars(s.costRateCents),
              },
              ...codes
                .filter(
                  (c) =>
                    c.active || snapshots.some((s) => s.entries.some((e) => e.rateCodeId === c.id)),
                )
                .map((c) => ({
                  key: `rc-${c.id}`,
                  header: c.code,
                  align: 'right' as const,
                  render: (s: Snapshot) => {
                    const e = s.entries.find((ee) => ee.rateCodeId === c.id);
                    return e ? dollars(e.billRateCents) : '—';
                  },
                })),
            ]}
            rows={snapshots}
            rowKey={(s) => s.id}
            empty="No snapshots."
          />
        )}
      </Card>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function Plain({ children }: { children: string | null | undefined }): JSX.Element {
  return <div style={{ fontSize: 14 }}>{children && children.length > 0 ? children : '—'}</div>;
}
