// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Template admin (v2 Sprint D). Replaces the read-only starter-pack
// viewer with full CRUD across the three template families:
//   Engagement / Letter / Client
//
// Each tab is a list with edit-in-place + clone + archive. New rows
// go through a small inline create form. The system templates seeded
// at install are marked with a "system" pill — you can clone them but
// editing/archiving leaves the originals intact (UI nicety; the API
// allows editing them too).

import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Pill, Tabs, tokens } from '@vibe/ui';

const FEE_OPTIONS = [
  { value: 'HOURLY', label: 'Hourly' },
  { value: 'HOURLY_NTE', label: 'Hourly (NTE)' },
  { value: 'FIXED_FEE', label: 'Fixed fee' },
  { value: 'FIXED_FEE_WITH_MILESTONES', label: 'Fixed fee + milestones' },
  { value: 'RECURRING_SUBSCRIPTION', label: 'Recurring subscription' },
];

import { api } from '../../api-client';
import { centsToDollarsInput, dollarsInputToCents } from '../../lib/money';

type Kind = 'engagement' | 'letter' | 'client';

interface EngagementTpl {
  id: string;
  key: string;
  name: string;
  defaultFeeStructure: string;
  defaultFeeAmountCents: number | null;
  defaultBudgetHours: string | null;
  defaultLetterTemplateId: string | null;
  defaultRateCodeId: string | null;
  // 0083 — Mustache name pattern resolved at engagement-creation time.
  namePattern: string | null;
  isSystem: boolean;
  status: string;
}

interface RateCode {
  id: string;
  code: string;
  active: boolean;
}

interface LetterTpl {
  id: string;
  key: string;
  name: string;
  bodyHtml: string;
  variablesJson: string[] | null;
  isSystem: boolean;
  status: string;
}

interface ClientTpl {
  id: string;
  key: string;
  name: string;
  clientType: 'INDIVIDUAL' | 'BUSINESS';
  defaultsJson: Record<string, unknown>;
  defaultEngagementTemplateIds: string[];
  isSystem: boolean;
  status: string;
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

function formatCents(c: number | null): string {
  if (c == null) return '—';
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function TemplatesPage(): JSX.Element {
  const [kind, setKind] = useState<Kind>('engagement');
  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Tabs
        tabs={[
          { key: 'engagement', label: 'Engagement templates' },
          { key: 'letter', label: 'Letter templates' },
          { key: 'client', label: 'Client templates' },
        ]}
        active={kind}
        onChange={(k) => setKind(k as Kind)}
      />
      {kind === 'engagement' && <EngagementTab />}
      {kind === 'letter' && <LetterTab />}
      {kind === 'client' && <ClientTab />}
    </div>
  );
}

function EngagementTab(): JSX.Element {
  const [items, setItems] = useState<EngagementTpl[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // QA fix — these string drafts now hold the *dollars* representation
  // typed in the input ("750.00"), not the cents string ("75000"). We
  // translate via dollarsInputToCents on submit. Earlier the field said
  // "Fee (cents)" and accepted 75000 to mean $750 which was confusing
  // for any user not steeped in the storage shape.
  const [rateCodes, setRateCodes] = useState<RateCode[]>([]);
  const [editDraft, setEditDraft] = useState<{
    name: string;
    defaultFeeStructure: string;
    defaultFeeAmountDollars: string;
    defaultBudgetHours: string;
    defaultRateCodeId: string;
    namePattern: string;
  }>({
    name: '',
    defaultFeeStructure: 'FIXED_FEE',
    defaultFeeAmountDollars: '',
    defaultBudgetHours: '',
    defaultRateCodeId: '',
    namePattern: '',
  });
  const [draft, setDraft] = useState({
    key: '',
    name: '',
    defaultFeeStructure: 'FIXED_FEE',
    defaultFeeAmountDollars: '',
    defaultBudgetHours: '',
    defaultRateCodeId: '',
    namePattern: '',
  });

  async function load(): Promise<void> {
    try {
      const [r, rc] = await Promise.all([
        api<{ items: EngagementTpl[] }>('/api/staff/admin/templates/engagement'),
        api<{ items: RateCode[] }>('/api/staff/admin/rate-codes').catch(() => ({ items: [] })),
      ]);
      setItems(r.items ?? []);
      setRateCodes((rc.items ?? []).filter((c) => c.active));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add(): Promise<void> {
    if (!draft.key.trim() || !draft.name.trim()) return;
    try {
      await api('/api/staff/admin/templates/engagement', {
        method: 'POST',
        body: JSON.stringify({
          key: draft.key.trim(),
          name: draft.name.trim(),
          defaultFeeStructure: draft.defaultFeeStructure,
          defaultFeeAmountCents: dollarsInputToCents(draft.defaultFeeAmountDollars),
          defaultBudgetHours: draft.defaultBudgetHours ? Number(draft.defaultBudgetHours) : null,
          defaultRateCodeId: draft.defaultRateCodeId || null,
          namePattern: draft.namePattern.trim() || null,
        }),
      });
      setDraft({
        key: '',
        name: '',
        defaultFeeStructure: 'FIXED_FEE',
        defaultFeeAmountDollars: '',
        defaultBudgetHours: '',
        defaultRateCodeId: '',
        namePattern: '',
      });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    }
  }

  async function clone(id: string): Promise<void> {
    try {
      await api(`/api/staff/admin/templates/engagement/${id}/clone`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'clone_failed');
    }
  }

  async function archive(id: string): Promise<void> {
    if (!confirm('Archive this template? It will be hidden from pickers.')) return;
    try {
      await api(`/api/staff/admin/templates/engagement/${id}/archive`, { method: 'PATCH' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  function beginEdit(t: EngagementTpl): void {
    setEditingId(t.id);
    setEditDraft({
      name: t.name,
      defaultFeeStructure: t.defaultFeeStructure,
      defaultFeeAmountDollars: centsToDollarsInput(t.defaultFeeAmountCents),
      defaultBudgetHours: t.defaultBudgetHours ?? '',
      defaultRateCodeId: t.defaultRateCodeId ?? '',
      namePattern: t.namePattern ?? '',
    });
  }

  async function saveEdit(id: string): Promise<void> {
    if (!editDraft.name.trim()) return;
    try {
      await api(`/api/staff/admin/templates/engagement/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editDraft.name.trim(),
          defaultFeeStructure: editDraft.defaultFeeStructure,
          defaultFeeAmountCents: dollarsInputToCents(editDraft.defaultFeeAmountDollars),
          defaultBudgetHours: editDraft.defaultBudgetHours
            ? Number(editDraft.defaultBudgetHours)
            : null,
          defaultRateCodeId: editDraft.defaultRateCodeId || null,
          namePattern: editDraft.namePattern.trim() || null,
        }),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  return (
    <Card
      title="Engagement templates"
      action={
        <Button size="sm" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : '+ New template'}
        </Button>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      {adding && (
        <div
          style={{
            padding: 12,
            marginBottom: 12,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            display: 'grid',
            gap: 8,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
            <input
              value={draft.key}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              placeholder="key (lower_snake) *"
              style={fieldStyle}
            />
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Name *"
              style={fieldStyle}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
            <Combobox
              ariaLabel="Default fee structure"
              value={draft.defaultFeeStructure}
              onChange={(v) => setDraft({ ...draft, defaultFeeStructure: v })}
              options={FEE_OPTIONS}
            />
            <input
              type="text"
              inputMode="decimal"
              value={draft.defaultFeeAmountDollars}
              onChange={(e) => setDraft({ ...draft, defaultFeeAmountDollars: e.target.value })}
              placeholder="Fee ($)"
              aria-label="Default fee in dollars"
              style={fieldStyle}
            />
            <input
              value={draft.defaultBudgetHours}
              onChange={(e) => setDraft({ ...draft, defaultBudgetHours: e.target.value })}
              placeholder="Budget hours"
              style={fieldStyle}
            />
          </div>
          <select
            value={draft.defaultRateCodeId}
            onChange={(e) => setDraft({ ...draft, defaultRateCodeId: e.target.value })}
            aria-label="Default rate code"
            style={fieldStyle}
          >
            <option value="">— StandardRate (default) —</option>
            {rateCodes.map((rc) => (
              <option key={rc.id} value={rc.id}>
                {rc.code}
              </option>
            ))}
          </select>
          <div>
            <label
              htmlFor="new-name-pattern"
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Name pattern (optional)
            </label>
            <input
              id="new-name-pattern"
              value={draft.namePattern}
              onChange={(e) => setDraft({ ...draft, namePattern: e.target.value })}
              placeholder="e.g. Bookkeeping {{period.month}}/{{period.year}}"
              aria-label="Engagement name pattern"
              style={{ ...fieldStyle, width: '100%' }}
            />
            <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '4px 0 0' }}>
              Tokens: <code>{'{{client.name}}'}</code>, <code>{'{{period.year}}'}</code>,{' '}
              <code>{'{{period.month}}'}</code>, <code>{'{{period.label}}'}</code>,{' '}
              <code>{'{{today}}'}</code>. Left blank → engagement name comes from the create form.
            </p>
          </div>
          <div>
            <Button size="sm" onClick={() => void add()}>
              Create
            </Button>
          </div>
        </div>
      )}
      {items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No templates yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map((t) => {
            const isEditing = editingId === t.id;
            return (
              <div
                key={t.id}
                style={{
                  padding: 10,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'grid',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {isEditing ? (
                    <input
                      value={editDraft.name}
                      onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                      style={{ ...fieldStyle, flex: 1, minWidth: 220 }}
                    />
                  ) : (
                    <strong style={{ fontSize: 13 }}>{t.name}</strong>
                  )}
                  <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{t.key}</code>
                  {!isEditing && <Pill>{t.defaultFeeStructure}</Pill>}
                  {!isEditing && (
                    <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                      {formatCents(t.defaultFeeAmountCents)} ·{' '}
                      {t.defaultBudgetHours ? `${t.defaultBudgetHours}h` : 'no budget'}
                    </span>
                  )}
                  {t.isSystem && <Pill tone="accent">system</Pill>}
                  {!isEditing && t.namePattern && (
                    <span
                      style={{
                        fontSize: 11,
                        color: tokens.color.textMuted,
                        fontFamily: 'monospace',
                      }}
                      title={`Engagement name pattern: ${t.namePattern}`}
                    >
                      📝 {t.namePattern}
                    </span>
                  )}
                  {t.status === 'ARCHIVED' && <Pill tone="warning">archived</Pill>}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {isEditing ? (
                      <>
                        <Button size="sm" onClick={() => void saveEdit(t.id)}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => beginEdit(t)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void clone(t.id)}>
                          Clone
                        </Button>
                        {t.status === 'ACTIVE' && (
                          <Button size="sm" variant="ghost" onClick={() => void archive(t.id)}>
                            Archive
                          </Button>
                        )}
                      </>
                    )}
                  </span>
                </div>
                {isEditing && (
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8 }}>
                    <Combobox
                      ariaLabel="Default fee structure"
                      value={editDraft.defaultFeeStructure}
                      onChange={(v) => setEditDraft({ ...editDraft, defaultFeeStructure: v })}
                      options={FEE_OPTIONS}
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      value={editDraft.defaultFeeAmountDollars}
                      onChange={(e) =>
                        setEditDraft({ ...editDraft, defaultFeeAmountDollars: e.target.value })
                      }
                      placeholder="Fee ($)"
                      aria-label="Default fee in dollars"
                      style={fieldStyle}
                    />
                    <input
                      value={editDraft.defaultBudgetHours}
                      onChange={(e) =>
                        setEditDraft({ ...editDraft, defaultBudgetHours: e.target.value })
                      }
                      placeholder="Budget hours"
                      style={fieldStyle}
                    />
                    <select
                      value={editDraft.defaultRateCodeId}
                      onChange={(e) =>
                        setEditDraft({ ...editDraft, defaultRateCodeId: e.target.value })
                      }
                      aria-label="Default rate code"
                      style={fieldStyle}
                    >
                      <option value="">— StandardRate (default) —</option>
                      {rateCodes.map((rc) => (
                        <option key={rc.id} value={rc.id}>
                          {rc.code}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {isEditing && (
                  <div>
                    <label
                      htmlFor={`edit-name-pattern-${t.id}`}
                      style={{
                        fontSize: 11,
                        color: tokens.color.textMuted,
                        display: 'block',
                        marginBottom: 4,
                      }}
                    >
                      Name pattern (optional)
                    </label>
                    <input
                      id={`edit-name-pattern-${t.id}`}
                      value={editDraft.namePattern}
                      onChange={(e) => setEditDraft({ ...editDraft, namePattern: e.target.value })}
                      placeholder="e.g. Bookkeeping {{period.month}}/{{period.year}}"
                      aria-label="Engagement name pattern"
                      style={{ ...fieldStyle, width: '100%' }}
                    />
                    <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '4px 0 0' }}>
                      Tokens: <code>{'{{client.name}}'}</code>, <code>{'{{period.year}}'}</code>,{' '}
                      <code>{'{{period.month}}'}</code>, <code>{'{{period.label}}'}</code>,{' '}
                      <code>{'{{today}}'}</code>.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function LetterTab(): JSX.Element {
  const [items, setItems] = useState<LetterTpl[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: LetterTpl[] }>('/api/staff/admin/templates/letter');
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(id: string): Promise<void> {
    try {
      await api(`/api/staff/admin/templates/letter/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ bodyHtml: editBody }),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  return (
    <Card title="Letter templates">
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Variables follow the same <code>{'{{entity.field}}'}</code> markers as notification
        templates. The &ldquo;Generate letter&rdquo; button on an engagement detail page substitutes
        them in.
      </p>
      <div style={{ display: 'grid', gap: 12 }}>
        {items.map((t) => (
          <div
            key={t.id}
            style={{
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>{t.name}</strong>
              <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{t.key}</code>
              {t.isSystem && <Pill tone="accent">system</Pill>}
              {t.variablesJson && t.variablesJson.length > 0 && (
                <Pill>{`${t.variablesJson.length} vars`}</Pill>
              )}
              <span style={{ marginLeft: 'auto' }}>
                {editingId === t.id ? (
                  <>
                    <Button size="sm" onClick={() => void save(t.id)}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(t.id);
                      setEditBody(t.bodyHtml);
                    }}
                  >
                    Edit body
                  </Button>
                )}
              </span>
            </div>
            {editingId === t.id ? (
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={10}
                style={{
                  ...fieldStyle,
                  fontFamily: tokens.font.mono,
                  resize: 'vertical',
                }}
              />
            ) : (
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  background: tokens.color.bg,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 11,
                  fontFamily: tokens.font.mono,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 160,
                  overflow: 'auto',
                }}
              >
                {t.bodyHtml}
              </pre>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ClientTab(): JSX.Element {
  const [items, setItems] = useState<ClientTpl[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editClientType, setEditClientType] = useState<'INDIVIDUAL' | 'BUSINESS'>('BUSINESS');
  const [editDefaults, setEditDefaults] = useState('');

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: ClientTpl[] }>('/api/staff/admin/templates/client');
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function beginEdit(t: ClientTpl): void {
    setEditingId(t.id);
    setEditName(t.name);
    setEditClientType(t.clientType);
    setEditDefaults(JSON.stringify(t.defaultsJson ?? {}, null, 2));
  }

  async function saveEdit(id: string): Promise<void> {
    let parsedDefaults: Record<string, unknown>;
    try {
      parsedDefaults = editDefaults.trim() ? JSON.parse(editDefaults) : {};
    } catch {
      setError('Defaults must be valid JSON.');
      return;
    }
    try {
      await api(`/api/staff/admin/templates/client/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          clientType: editClientType,
          defaultsJson: parsedDefaults,
        }),
      });
      setEditingId(null);
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  async function archive(id: string): Promise<void> {
    if (!confirm('Archive this client template? Wizard will no longer offer it.')) return;
    try {
      await api(`/api/staff/admin/templates/client/${id}/archive`, { method: 'PATCH' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  return (
    <Card title="Client templates">
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Prefill defaults for the Create Client wizard. Picking a template fills tags, terms, and
        pipeline stage in the wizard. <code>defaultsJson</code> keys match wizard field names (e.g.{' '}
        <code>termsDays</code>, <code>pipelineStage</code>, <code>tags</code>).
      </p>
      {items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No templates yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map((t) => {
            const isEditing = editingId === t.id;
            return (
              <div
                key={t.id}
                style={{
                  padding: 10,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'grid',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {isEditing ? (
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={{ ...fieldStyle, flex: 1, minWidth: 220 }}
                    />
                  ) : (
                    <strong style={{ fontSize: 13 }}>{t.name}</strong>
                  )}
                  <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{t.key}</code>
                  {isEditing ? (
                    <Combobox
                      ariaLabel="Client type"
                      value={editClientType}
                      onChange={(v) => setEditClientType(v as 'INDIVIDUAL' | 'BUSINESS')}
                      options={[
                        { value: 'INDIVIDUAL', label: 'Individual' },
                        { value: 'BUSINESS', label: 'Business' },
                      ]}
                    />
                  ) : (
                    <Pill>{t.clientType}</Pill>
                  )}
                  {t.isSystem && <Pill tone="accent">system</Pill>}
                  {t.status === 'ARCHIVED' && <Pill tone="warning">archived</Pill>}
                  {!isEditing && (
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      {Object.keys(t.defaultsJson ?? {}).length} default field(s)
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {isEditing ? (
                      <>
                        <Button size="sm" onClick={() => void saveEdit(t.id)}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => beginEdit(t)}>
                          Edit
                        </Button>
                        {t.status === 'ACTIVE' && (
                          <Button size="sm" variant="ghost" onClick={() => void archive(t.id)}>
                            Archive
                          </Button>
                        )}
                      </>
                    )}
                  </span>
                </div>
                {isEditing && (
                  <textarea
                    value={editDefaults}
                    onChange={(e) => setEditDefaults(e.target.value)}
                    rows={6}
                    style={{
                      ...fieldStyle,
                      fontFamily: tokens.font.mono,
                      fontSize: 11,
                      resize: 'vertical',
                    }}
                    aria-label="Defaults JSON"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
