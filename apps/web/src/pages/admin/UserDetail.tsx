// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
import { useParams, useSearchParams } from 'react-router-dom';

import { Button, Card, Combobox, Input, Pill, Table, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';
import { BookingSettingsEditor } from '../BookingSettingsEditor';

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
  businessPhoneExt: string | null;
  homePhone: string | null;
  homePhoneExt: string | null;
  faxPhone: string | null;
  faxPhoneExt: string | null;
  mobilePhone: string | null;
  mobilePhoneExt: string | null;
  secondaryEmail: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  addressCountry: string | null;
  homeAddressLine1: string | null;
  homeAddressLine2: string | null;
  homeCity: string | null;
  homeState: string | null;
  homeZip: string | null;
  homeCountry: string | null;
  hiredDate: string | null;
  leftDate: string | null;
  defaultOfficeId: string | null;
  status: string;
  totpEnrolledAt: string | null;
  standardHoursPerWeek: string;
  billableTargetHoursPerMonth: number | null;
  // 0062 — profile expansion
  // (0063 dropped costRateCents — the per-snapshot cost rate is the
  //  source of truth, edited via the snapshot create form below.)
  displayId: string | null;
  description: string | null;
  photoUrl: string | null;
  internalNotes: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface StaffSkillRow {
  id: string;
  workCodeId: string;
  workCodeKey: string;
  workCodeName: string;
  proficiency: 'LEARNING' | 'COMPETENT' | 'PROFICIENT' | 'EXPERT';
  notes: string | null;
  updatedAt: string;
}

interface WorkCodeOption {
  id: string;
  key: string;
  name: string;
}

interface StaffTargetRow {
  id: string;
  targetYear: number;
  annualBillableHours: string | null;
  annualTotalHours: string | null;
  targetRealizationPctBps: number | null;
  targetUtilizationPctBps: number | null;
  notes: string | null;
  updatedAt: string;
}

interface RoleAssignment {
  id: string;
  name: string;
}

interface RoleOption {
  id: string;
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

type Tab = 'main' | 'contact' | 'rates' | 'skills' | 'targets' | 'payroll' | 'notes' | 'booking';

const fieldStyle: React.CSSProperties = {
  boxSizing: 'border-box',
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
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const VALID_TABS: Tab[] = [
    'main',
    'contact',
    'rates',
    'skills',
    'targets',
    'payroll',
    'notes',
    'booking',
  ];
  const [tab, setTab] = useState<Tab>(
    VALID_TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : 'main',
  );
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

  // The endpoint replaces the user's full role set, so both assign and
  // remove send the complete desired list.
  async function saveRoles(roleIds: string[]): Promise<void> {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleIds }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'role_save_failed');
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

  // Switching tabs cancels any in-progress profile edit so the Edit/draft
  // state (shared by Main/Contact/Notes) doesn't bleed into another tab.
  function changeTab(next: Tab): void {
    if (next === tab) return;
    setEditingProfile(false);
    setDraft({});
    setTab(next);
  }

  if (!user) {
    return (
      <Card title="User">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>{error ?? 'Loading…'}</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.md, maxWidth: 1000, alignContent: 'start' }}>
      {status && (
        <p style={{ color: tokens.color.success, fontSize: 12, margin: 0 }} role="status">
          {status}
        </p>
      )}
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
          {error}
        </p>
      )}

      {/* Header: title + tabs grouped tightly so the first card sits near the top. */}
      <div style={{ display: 'grid', gap: 8 }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>{user.fullName}</span>
            <Pill tone={user.status === 'ACTIVE' ? 'success' : 'warning'}>{user.status}</Pill>
          </h1>
        </div>

        <div
          role="tablist"
          aria-label="User tabs"
          style={{
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <TabButton current={tab} value="main" onSelect={changeTab}>
            Main
          </TabButton>
          <TabButton current={tab} value="contact" onSelect={changeTab}>
            Contact Info
          </TabButton>
          <TabButton current={tab} value="rates" onSelect={changeTab}>
            Rates
          </TabButton>
          <TabButton current={tab} value="skills" onSelect={changeTab}>
            Skill Set
          </TabButton>
          <TabButton current={tab} value="targets" onSelect={changeTab}>
            Targets
          </TabButton>
          <TabButton current={tab} value="payroll" onSelect={changeTab}>
            Payroll
          </TabButton>
          <TabButton current={tab} value="notes" onSelect={changeTab}>
            Notes
          </TabButton>
          <TabButton current={tab} value="booking" onSelect={changeTab}>
            Booking
          </TabButton>
        </div>
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
      {tab === 'skills' && id && <SkillsTab userId={id} />}
      {tab === 'targets' && id && <TargetsTab userId={id} />}
      {tab === 'payroll' && id && <PayrollTab userId={id} />}
      {tab === 'booking' && id && <BookingSettingsEditor userId={id} />}
      {tab === 'notes' && (
        <NotesTab
          user={user}
          draft={draft}
          setDraft={setDraft}
          editing={editingProfile}
          setEditing={setEditingProfile}
          onSave={() => void saveProfile()}
          busy={busy}
        />
      )}

      {/* Roles / Authentication / Lifecycle are account-level, so they
          live on the Main tab only (they used to render under every tab). */}
      {tab === 'main' && (
        <>
          <Card
            title="Roles"
            action={
              <div style={{ width: 220 }}>
                <Combobox
                  ariaLabel="Assign role"
                  disabled={busy}
                  value=""
                  onChange={(val) => {
                    if (val) {
                      void saveRoles([...roles.map((r) => r.id), val]);
                    }
                  }}
                  options={allRoles
                    .filter((r) => !roles.some((cur) => cur.id === r.id))
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
                  <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    <Pill tone="accent">{r.name}</Pill>
                    <button
                      type="button"
                      aria-label={`Remove role ${r.name}`}
                      title="Remove role"
                      disabled={busy}
                      onClick={() =>
                        void saveRoles(roles.filter((x) => x.id !== r.id).map((x) => x.id))
                      }
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: tokens.color.textMuted,
                        fontSize: 12,
                        padding: '0 2px',
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Card>

          <Card title="Authentication">
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
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
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void resetTotp()}
                  disabled={busy}
                >
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
        </>
      )}
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
      {/* 0062 — ID + Description + Photo (top row, matches CCH Main tab) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '180px 1fr 120px',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Field label="ID">
          {editing ? (
            <input
              value={v('displayId')}
              onChange={(e) => setDraft({ ...draft, displayId: e.target.value })}
              placeholder="e.g. SCHEN"
              style={fieldStyle}
              maxLength={40}
            />
          ) : (
            <Plain>{user.displayId}</Plain>
          )}
        </Field>
        <Field label="Description">
          {editing ? (
            <input
              value={v('description')}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Display label (e.g. Partner)"
              style={fieldStyle}
            />
          ) : (
            <Plain>{user.description}</Plain>
          )}
        </Field>
        <Field label="Photo">
          {editing ? (
            <input
              value={v('photoUrl')}
              onChange={(e) => setDraft({ ...draft, photoUrl: e.target.value })}
              placeholder="URL"
              style={fieldStyle}
            />
          ) : user.photoUrl ? (
            <img
              src={user.photoUrl}
              alt=""
              style={{ width: 56, height: 56, borderRadius: 4, objectFit: 'cover' }}
            />
          ) : (
            <Plain>—</Plain>
          )}
        </Field>
      </div>
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
      <div
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Email">
            <Plain>{user.email}</Plain>
          </Field>
          <Field label="Secondary email">{inp('secondaryEmail')}</Field>
          <Field label="Title">{inp('title')}</Field>
          <Field label="Salutation">{inp('salutation')}</Field>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          {/* Phone + extension pairs */}
          <PhoneWithExt
            label="Business"
            phoneKey="businessPhone"
            extKey="businessPhoneExt"
            user={user}
            draft={draft}
            setDraft={setDraft}
            editing={editing}
          />
          <PhoneWithExt
            label="Home"
            phoneKey="homePhone"
            extKey="homePhoneExt"
            user={user}
            draft={draft}
            setDraft={setDraft}
            editing={editing}
          />
          <PhoneWithExt
            label="Mobile"
            phoneKey="mobilePhone"
            extKey="mobilePhoneExt"
            user={user}
            draft={draft}
            setDraft={setDraft}
            editing={editing}
          />
          <PhoneWithExt
            label="Fax"
            phoneKey="faxPhone"
            extKey="faxPhoneExt"
            user={user}
            draft={draft}
            setDraft={setDraft}
            editing={editing}
          />
        </div>
      </div>
      {/* Business/Home address sections removed — staff records don't
          need per-user mailing addresses (the columns remain in the DB
          and PATCH schema if a future need shows up). */}
    </Card>
  );
}

function PhoneWithExt({
  label,
  phoneKey,
  extKey,
  user,
  draft,
  setDraft,
  editing,
}: {
  label: string;
  phoneKey: keyof User;
  extKey: keyof User;
  user: User;
  draft: Partial<User>;
  setDraft: (d: Partial<User>) => void;
  editing: boolean;
}): JSX.Element {
  const phoneVal =
    (draft[phoneKey] as string | null | undefined) ?? (user[phoneKey] as string | null) ?? '';
  const extVal =
    (draft[extKey] as string | null | undefined) ?? (user[extKey] as string | null) ?? '';
  return (
    <Field label={label}>
      {editing ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 6 }}>
          <input
            value={phoneVal}
            onChange={(e) =>
              setDraft({ ...draft, [phoneKey]: e.target.value || null } as Partial<User>)
            }
            style={fieldStyle}
            placeholder="Number"
          />
          <input
            value={extVal}
            onChange={(e) =>
              setDraft({ ...draft, [extKey]: e.target.value || null } as Partial<User>)
            }
            style={fieldStyle}
            placeholder="Ext"
            maxLength={12}
          />
        </div>
      ) : (
        <Plain>{phoneVal || extVal ? `${phoneVal}${extVal ? ' x' + extVal : ''}` : null}</Plain>
      )}
    </Field>
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
  // 0063 — current cost rate is shown as a banner derived from the
  // latest snapshot. To change it, the user appends a new snapshot
  // (immutability is the whole point — see migration 0063 header).
  const latestSnap = snapshots[0];
  return (
    <>
      <Card title="Current cost rate">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0, marginBottom: 8 }}>
          What the firm pays this staff person per hour. Derived from the most recent rate snapshot
          below. Snapshots are append-only; to change the cost rate, add a new effective period.
        </p>
        <div style={{ fontSize: 22, fontWeight: 600 }}>
          {latestSnap ? dollars(latestSnap.costRateCents) : '—'}
        </div>
        {latestSnap && (
          <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 4 }}>
            Effective {latestSnap.effectiveDate}
          </div>
        )}
      </Card>

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
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                marginTop: 12,
                justifyContent: 'flex-end',
              }}
            >
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

// =====================================================================
// 0062 — Skill Set tab
// =====================================================================

const PROFICIENCY_OPTIONS: Array<{
  value: 'LEARNING' | 'COMPETENT' | 'PROFICIENT' | 'EXPERT';
  label: string;
}> = [
  { value: 'LEARNING', label: 'Learning' },
  { value: 'COMPETENT', label: 'Competent' },
  { value: 'PROFICIENT', label: 'Proficient' },
  { value: 'EXPERT', label: 'Expert' },
];

function proficiencyTone(p: string): 'neutral' | 'warning' | 'success' | 'accent' {
  switch (p) {
    case 'LEARNING':
      return 'warning';
    case 'COMPETENT':
      return 'neutral';
    case 'PROFICIENT':
      return 'accent';
    case 'EXPERT':
      return 'success';
    default:
      return 'neutral';
  }
}

function SkillsTab({ userId }: { userId: string }): JSX.Element {
  const [items, setItems] = useState<StaffSkillRow[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCodeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newCodeId, setNewCodeId] = useState('');
  const [newProficiency, setNewProficiency] = useState<StaffSkillRow['proficiency']>('COMPETENT');
  const [newNotes, setNewNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    setError(null);
    try {
      const [s, wc] = await Promise.all([
        api<{ items: StaffSkillRow[] }>(`/api/staff/admin/users/${userId}/skills`),
        api<{ items: WorkCodeOption[] }>('/api/staff/taxonomy/work-codes'),
      ]);
      setItems(s.items ?? []);
      setWorkCodes(wc.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function addSkill(): Promise<void> {
    if (!newCodeId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${userId}/skills`, {
        method: 'POST',
        body: JSON.stringify({
          workCodeId: newCodeId,
          proficiency: newProficiency,
          notes: newNotes || null,
        }),
      });
      setAdding(false);
      setNewCodeId('');
      setNewProficiency('COMPETENT');
      setNewNotes('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  async function removeSkill(skillId: string): Promise<void> {
    if (!confirm('Remove this skill?')) return;
    setBusy(true);
    try {
      await api(`/api/staff/admin/users/${userId}/skills/${skillId}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete_failed');
    } finally {
      setBusy(false);
    }
  }

  const assignedIds = new Set(items.map((i) => i.workCodeId));
  const available = workCodes.filter((w) => !assignedIds.has(w.id));

  return (
    <Card
      title="Skill Set"
      action={
        adding ? null : (
          <Button size="sm" onClick={() => setAdding(true)} disabled={available.length === 0}>
            + Add skill
          </Button>
        )
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0, marginBottom: 12 }}>
          {error}
        </p>
      )}
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0, marginBottom: 12 }}>
        Work codes this staff member is qualified to perform. Used by engagement assignment
        suggestions and capacity planning.
      </p>
      {adding && (
        <div
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: 12,
            marginBottom: 16,
            display: 'grid',
            gap: 12,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Field label="Work code">
              <Combobox
                ariaLabel="Work code"
                value={newCodeId}
                onChange={setNewCodeId}
                options={available.map<ComboboxOption>((w) => ({
                  value: w.id,
                  label: `${w.key} — ${w.name}`,
                }))}
                placeholder="Pick a work code"
              />
            </Field>
            <Field label="Proficiency">
              <select
                value={newProficiency}
                onChange={(e) => setNewProficiency(e.target.value as StaffSkillRow['proficiency'])}
                style={fieldStyle}
              >
                {PROFICIENCY_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Notes (optional)">
            <input
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              style={fieldStyle}
              maxLength={1000}
            />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => void addSkill()} disabled={busy || !newCodeId}>
              {busy ? 'Adding…' : 'Add'}
            </Button>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <Table<StaffSkillRow>
        rows={items}
        rowKey={(r) => r.id}
        empty="No skills recorded. Click + Add skill to tag work codes."
        columns={[
          {
            key: 'code',
            header: 'Work code',
            render: (r) => (
              <span>
                <code style={{ fontSize: 11 }}>{r.workCodeKey}</code> {r.workCodeName}
              </span>
            ),
          },
          {
            key: 'prof',
            header: 'Proficiency',
            render: (r) => <Pill tone={proficiencyTone(r.proficiency)}>{r.proficiency}</Pill>,
          },
          {
            key: 'notes',
            header: 'Notes',
            render: (r) => (
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{r.notes ?? '—'}</span>
            ),
          },
          {
            key: 'actions',
            header: '',
            render: (r) => (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void removeSkill(r.id)}
                disabled={busy}
              >
                Remove
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}

// =====================================================================
// 0062 — Targets tab
// =====================================================================

function bpsToPct(bps: number | null | undefined): string {
  if (bps == null) return '';
  return (bps / 100).toFixed(1);
}

function TargetsTab({ userId }: { userId: string }): JSX.Element {
  const [items, setItems] = useState<StaffTargetRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draftYear, setDraftYear] = useState(new Date().getFullYear());
  const [draftBillable, setDraftBillable] = useState('');
  const [draftTotal, setDraftTotal] = useState('');
  const [draftRealization, setDraftRealization] = useState('');
  const [draftUtilization, setDraftUtilization] = useState('');
  const [draftNotes, setDraftNotes] = useState('');

  async function load(): Promise<void> {
    setError(null);
    try {
      const r = await api<{ items: StaffTargetRow[] }>(`/api/staff/admin/users/${userId}/targets`);
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  function resetDraft(): void {
    setDraftYear(new Date().getFullYear());
    setDraftBillable('');
    setDraftTotal('');
    setDraftRealization('');
    setDraftUtilization('');
    setDraftNotes('');
  }

  function startEdit(row: StaffTargetRow): void {
    setDraftYear(row.targetYear);
    setDraftBillable(row.annualBillableHours ?? '');
    setDraftTotal(row.annualTotalHours ?? '');
    setDraftRealization(bpsToPct(row.targetRealizationPctBps));
    setDraftUtilization(bpsToPct(row.targetUtilizationPctBps));
    setDraftNotes(row.notes ?? '');
    setAdding(true);
  }

  async function saveTarget(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { targetYear: draftYear };
      if (draftBillable.trim()) payload['annualBillableHours'] = parseFloat(draftBillable);
      if (draftTotal.trim()) payload['annualTotalHours'] = parseFloat(draftTotal);
      if (draftRealization.trim())
        payload['targetRealizationPctBps'] = Math.round(parseFloat(draftRealization) * 100);
      if (draftUtilization.trim())
        payload['targetUtilizationPctBps'] = Math.round(parseFloat(draftUtilization) * 100);
      if (draftNotes.trim()) payload['notes'] = draftNotes;
      await api(`/api/staff/admin/users/${userId}/targets`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAdding(false);
      resetDraft();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function removeTarget(targetId: string): Promise<void> {
    if (!confirm('Remove this target?')) return;
    setBusy(true);
    try {
      await api(`/api/staff/admin/users/${userId}/targets/${targetId}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Annual targets"
      action={
        adding ? null : (
          <Button
            size="sm"
            onClick={() => {
              resetDraft();
              setAdding(true);
            }}
          >
            + New target year
          </Button>
        )
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0, marginBottom: 12 }}>
          {error}
        </p>
      )}
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0, marginBottom: 12 }}>
        One row per year. Realization and utilization are stored as percentages (0–100).
      </p>
      {adding && (
        <div
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: 12,
            marginBottom: 16,
            display: 'grid',
            gap: 12,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr', gap: 12 }}>
            <Field label="Year">
              <input
                type="number"
                value={draftYear}
                onChange={(e) => setDraftYear(parseInt(e.target.value, 10) || draftYear)}
                style={fieldStyle}
                min={2000}
                max={2100}
              />
            </Field>
            <Field label="Annual billable hours">
              <input
                type="number"
                step="0.5"
                value={draftBillable}
                onChange={(e) => setDraftBillable(e.target.value)}
                style={fieldStyle}
                placeholder="e.g. 1800"
              />
            </Field>
            <Field label="Annual total hours">
              <input
                type="number"
                step="0.5"
                value={draftTotal}
                onChange={(e) => setDraftTotal(e.target.value)}
                style={fieldStyle}
                placeholder="e.g. 2080"
              />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Realization target (%)">
              <input
                type="number"
                step="0.1"
                min={0}
                max={100}
                value={draftRealization}
                onChange={(e) => setDraftRealization(e.target.value)}
                style={fieldStyle}
                placeholder="e.g. 90"
              />
            </Field>
            <Field label="Utilization target (%)">
              <input
                type="number"
                step="0.1"
                min={0}
                max={100}
                value={draftUtilization}
                onChange={(e) => setDraftUtilization(e.target.value)}
                style={fieldStyle}
                placeholder="e.g. 80"
              />
            </Field>
          </div>
          <Field label="Notes (optional)">
            <textarea
              value={draftNotes}
              onChange={(e) => setDraftNotes(e.target.value)}
              style={{ ...fieldStyle, fontFamily: tokens.font.body }}
              rows={2}
              maxLength={2000}
            />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => void saveTarget()} disabled={busy || !draftYear}>
              {busy ? 'Saving…' : 'Save target'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setAdding(false);
                resetDraft();
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <Table<StaffTargetRow>
        rows={items}
        rowKey={(r) => r.id}
        empty="No targets yet."
        columns={[
          { key: 'year', header: 'Year', render: (r) => <strong>{r.targetYear}</strong> },
          {
            key: 'bill',
            header: 'Billable',
            render: (r) => <span>{r.annualBillableHours ?? '—'}</span>,
          },
          {
            key: 'total',
            header: 'Total',
            render: (r) => <span>{r.annualTotalHours ?? '—'}</span>,
          },
          {
            key: 'real',
            header: 'Realization %',
            render: (r) => <span>{bpsToPct(r.targetRealizationPctBps) || '—'}</span>,
          },
          {
            key: 'util',
            header: 'Utilization %',
            render: (r) => <span>{bpsToPct(r.targetUtilizationPctBps) || '—'}</span>,
          },
          {
            key: 'actions',
            header: '',
            render: (r) => (
              <div style={{ display: 'flex', gap: 6 }}>
                <Button size="sm" variant="secondary" onClick={() => startEdit(r)} disabled={busy}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void removeTarget(r.id)}
                  disabled={busy}
                >
                  Remove
                </Button>
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}

// =====================================================================
// 0062 — Notes tab
// =====================================================================

function NotesTab({
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
  return (
    <Card
      title="Internal notes"
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
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0, marginBottom: 12 }}>
        Internal notes about this staff member. Visible to admins only; never shown to clients.
      </p>
      {editing ? (
        <textarea
          value={(draft.internalNotes as string | null | undefined) ?? user.internalNotes ?? ''}
          onChange={(e) => setDraft({ ...draft, internalNotes: e.target.value || null })}
          style={{ ...fieldStyle, fontFamily: tokens.font.body, minHeight: 200 }}
          rows={10}
          maxLength={5000}
        />
      ) : user.internalNotes ? (
        <pre
          style={{
            fontFamily: tokens.font.body,
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            margin: 0,
          }}
        >
          {user.internalNotes}
        </pre>
      ) : (
        <Plain>—</Plain>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------
// Payroll tab (0226) — classification flags, assigned accrual policies,
// PTO/Sick/Comp balances, ledger history, and the manual adjustment
// dialog (go-live starting balances, corrections, comp grants).
// ---------------------------------------------------------------------

interface PayrollBank {
  bank: 'PTO' | 'SICK' | 'COMP';
  accruedHours: number;
  usedHours: number;
  balanceHours: number;
}

interface PayrollAssignment {
  id: string;
  bank: string;
  policyName: string;
  effectiveDate: string;
}

interface LedgerRow {
  id: string;
  bank: string;
  entryDate: string;
  deltaHours: string;
  reason: string;
  note: string;
  createdAt: string;
}

function PayrollTab({ userId }: { userId: string }): JSX.Element {
  const [flags, setFlags] = useState<{ overtimeExempt: boolean; isFullTime: boolean } | null>(null);
  const [banks, setBanks] = useState<PayrollBank[]>([]);
  const [assignments, setAssignments] = useState<PayrollAssignment[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Manual adjustment form.
  const [adjBank, setAdjBank] = useState<'PTO' | 'SICK' | 'COMP'>('PTO');
  const [adjHours, setAdjHours] = useState('');
  const [adjNote, setAdjNote] = useState('');
  const [adjBusy, setAdjBusy] = useState(false);

  async function loadPayroll(): Promise<void> {
    try {
      const [u, bal, asg, led] = await Promise.all([
        api<{ user: { overtimeExempt?: boolean; isFullTime?: boolean } }>(
          `/api/staff/admin/users/${userId}`,
        ),
        api<{ items: Array<{ appUserId: string; banks: PayrollBank[] }> }>(
          '/api/staff/payroll/balances',
        ),
        api<{ items: PayrollAssignment[] }>(`/api/staff/payroll/assignments?appUserId=${userId}`),
        api<{ items: LedgerRow[] }>(`/api/staff/payroll/ledger?appUserId=${userId}`),
      ]);
      setFlags({
        overtimeExempt: u.user.overtimeExempt ?? true,
        isFullTime: u.user.isFullTime ?? true,
      });
      setBanks(bal.items.find((i) => i.appUserId === userId)?.banks ?? []);
      setAssignments(asg.items ?? []);
      setLedger(led.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void loadPayroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function saveFlag(patch: {
    overtimeExempt?: boolean;
    isFullTime?: boolean;
  }): Promise<void> {
    setError(null);
    try {
      await api(`/api/staff/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await loadPayroll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function submitAdjustment(): Promise<void> {
    const delta = Number(adjHours);
    if (!delta || !adjNote.trim()) {
      setError('Adjustment needs non-zero hours and a reason note.');
      return;
    }
    setError(null);
    setNotice(null);
    setAdjBusy(true);
    try {
      await api('/api/staff/payroll/ledger/adjustment', {
        method: 'POST',
        body: JSON.stringify({
          appUserId: userId,
          bank: adjBank,
          deltaHours: delta,
          reason: 'ADJUSTMENT',
          note: adjNote.trim(),
        }),
      });
      setNotice(`Adjusted ${adjBank} by ${delta > 0 ? '+' : ''}${delta}h.`);
      setAdjHours('');
      setAdjNote('');
      await loadPayroll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setAdjBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      {notice && <p style={{ color: tokens.color.accent, fontSize: 13 }}>{notice}</p>}

      <Card title="Classification">
        {flags ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={flags.overtimeExempt}
                onChange={(e) => void saveFlag({ overtimeExempt: e.target.checked })}
              />
              Exempt from overtime (salaried — payroll uses standard hours, no OT)
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={flags.isFullTime}
                onChange={(e) => void saveFlag({ isFullTime: e.target.checked })}
              />
              Full-time (accrues PTO/Sick/Comp; part-timers report worked hours only)
            </label>
          </div>
        ) : (
          <p style={{ fontSize: 13 }}>Loading…</p>
        )}
      </Card>

      <Card title="Balances">
        <Table<PayrollBank>
          columns={[
            { key: 'bank', header: 'Bank', render: (b) => <Pill tone="accent">{b.bank}</Pill> },
            { key: 'accrued', header: 'Accrued', render: (b) => b.accruedHours.toFixed(2) },
            { key: 'used', header: 'Used', render: (b) => b.usedHours.toFixed(2) },
            {
              key: 'balance',
              header: 'Balance',
              render: (b) => (
                <strong
                  style={{ color: b.balanceHours < 0 ? tokens.color.danger : tokens.color.text }}
                >
                  {b.balanceHours.toFixed(2)}h
                </strong>
              ),
            },
          ]}
          rows={banks}
          rowKey={(b) => b.bank}
          empty="No balances yet."
        />
        <div style={{ marginTop: 12, fontSize: 12, color: tokens.color.textMuted }}>
          Assigned policies:{' '}
          {assignments.length > 0
            ? assignments.map((a) => `${a.bank} → ${a.policyName}`).join(' · ')
            : 'none (assign on Admin → Payroll)'}
        </div>
      </Card>

      <Card title="Manual balance adjustment">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr 2fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            Bank
            <select
              value={adjBank}
              onChange={(e) => setAdjBank(e.target.value as typeof adjBank)}
              style={{
                padding: '8px 10px',
                fontSize: 13,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
                background: tokens.color.bg,
                color: tokens.color.text,
              }}
            >
              <option>PTO</option>
              <option>SICK</option>
              <option>COMP</option>
            </select>
          </label>
          <Input
            label="Hours (± allowed)"
            type="number"
            step="0.25"
            value={adjHours}
            onChange={(e) => setAdjHours(e.target.value)}
          />
          <Input
            label="Reason note (required)"
            value={adjNote}
            onChange={(e) => setAdjNote(e.target.value)}
          />
          <Button disabled={adjBusy} onClick={() => void submitAdjustment()}>
            {adjBusy ? 'Saving…' : 'Apply'}
          </Button>
        </div>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 0 }}>
          Writes an append-only ledger entry (audit-logged). Use for go-live starting balances,
          corrections, or comp-time grants.
        </p>
      </Card>

      <Card title="Ledger history">
        <Table<LedgerRow>
          columns={[
            { key: 'date', header: 'Date', render: (l) => l.entryDate },
            { key: 'bank', header: 'Bank', render: (l) => l.bank },
            {
              key: 'delta',
              header: 'Hours',
              render: (l) => {
                const n = Number(l.deltaHours);
                return (
                  <span style={{ color: n < 0 ? tokens.color.danger : tokens.color.text }}>
                    {n > 0 ? '+' : ''}
                    {n.toFixed(2)}
                  </span>
                );
              },
            },
            { key: 'reason', header: 'Reason', render: (l) => l.reason },
            { key: 'note', header: 'Note', render: (l) => l.note || '—' },
          ]}
          rows={ledger}
          rowKey={(l) => l.id}
          empty="No ledger entries yet."
        />
      </Card>
    </div>
  );
}
