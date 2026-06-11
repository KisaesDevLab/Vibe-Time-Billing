// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin: per-return-type bookmark rules that locate signature pages inside a
// tax-return PDF. Rules are grouped by form type; each rule maps a PDF bookmark
// (matched by contains/exact/regex) to a signature-field layout.
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';

type MatchMode = 'contains' | 'exact' | 'regex';
type LayoutKey = 'us-8879' | 'entity-8879' | 'state-auth' | 'generic';

interface PageRule {
  id: string;
  formType: string;
  bookmarkPattern: string;
  matchMode: MatchMode;
  caseSensitive: boolean;
  layoutKey: LayoutKey;
  /** When set, the firm's latest placement profile for this form type
   *  supplies the fields; layoutKey is the fallback. */
  profileFormType: string | null;
  enabled: boolean;
  notes: string | null;
  sortOrder: number;
}

interface PlacementProfile {
  id: string;
  formType: string;
  version: number;
}

const FORM_TYPE_OPTIONS = [
  '1040',
  '1040-NR',
  '1041',
  '1065',
  '1120',
  '1120-S',
  '1120-F',
  '990',
  '990-PF',
  '990-T',
  '706',
  '709',
  '5500',
  '940',
  '941',
  '943',
  '944',
  '*',
] as const;

const FORM_TYPE_LABELS: Record<string, string> = { '*': 'Any (*)' };

const CUSTOM_FORM_TYPE = '__custom__';

function formTypeOptions(): { value: string; label: string }[] {
  return [
    ...FORM_TYPE_OPTIONS.map((v) => ({ value: v, label: FORM_TYPE_LABELS[v] ?? v })),
    { value: CUSTOM_FORM_TYPE, label: 'Custom…' },
  ];
}

const MATCH_MODE_OPTIONS: { value: MatchMode; label: string }[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'exact', label: 'Exact' },
  { value: 'regex', label: 'Regex' },
];

const LAYOUT_OPTIONS: { value: LayoutKey; label: string }[] = [
  { value: 'us-8879', label: '1040 8879 (taxpayer+spouse)' },
  { value: 'entity-8879', label: 'Entity 8879 (officer)' },
  { value: 'state-auth', label: 'State auth (taxpayer+spouse)' },
  { value: 'generic', label: 'Generic' },
];

function layoutLabel(key: LayoutKey): string {
  return LAYOUT_OPTIONS.find((o) => o.value === key)?.label ?? key;
}

// The layout picker mixes the four built-in layouts with the firm's saved
// placement profiles (value-encoded as `profile:<formType>`; the latest
// version resolves when a package is built).
const PROFILE_PREFIX = 'profile:';

function layoutChoiceOptions(profiles: PlacementProfile[]): { value: string; label: string }[] {
  return [
    ...LAYOUT_OPTIONS,
    ...profiles.map((p) => ({
      value: `${PROFILE_PREFIX}${p.formType}`,
      label: `Profile: ${p.formType} (v${p.version})`,
    })),
  ];
}

function choiceFromRule(r: PageRule): string {
  return r.profileFormType ? `${PROFILE_PREFIX}${r.profileFormType}` : r.layoutKey;
}

function patchFromChoice(v: string): { layoutKey?: LayoutKey; profileFormType: string | null } {
  return v.startsWith(PROFILE_PREFIX)
    ? { profileFormType: v.slice(PROFILE_PREFIX.length) }
    : { layoutKey: v as LayoutKey, profileFormType: null };
}

export function SignaturePageRulesPage(): JSX.Element {
  const canWrite = usePermission('firm:settings:write');
  const [rules, setRules] = useState<PageRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Add-rule form state. `formTypeSel` drives the dropdown; when it is the
  // custom sentinel the actual value comes from `customFormType`.
  const [formTypeSel, setFormTypeSel] = useState<string>('1040');
  const [customFormType, setCustomFormType] = useState('');
  const formType = formTypeSel === CUSTOM_FORM_TYPE ? customFormType.trim() : formTypeSel;
  const [bookmarkPattern, setBookmarkPattern] = useState('');
  const [matchMode, setMatchMode] = useState<MatchMode>('contains');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [layoutChoice, setLayoutChoice] = useState<string>('us-8879');
  const [enabled, setEnabled] = useState(true);
  const [notes, setNotes] = useState('');
  const [profiles, setProfiles] = useState<PlacementProfile[]>([]);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [r, p] = await Promise.all([
        api<{ rules: PageRule[] }>('/api/staff/admin/signature-config/page-rules'),
        api<{ profiles: PlacementProfile[] }>('/api/staff/signatures/profiles').catch(() => ({
          profiles: [],
        })),
      ]);
      setRules(r.rules ?? []);
      setProfiles(p.profiles ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (formType === '') {
      setErr('form_type_required');
      return;
    }
    try {
      const choice = patchFromChoice(layoutChoice);
      await api('/api/staff/admin/signature-config/page-rules', {
        method: 'POST',
        body: JSON.stringify({
          formType,
          bookmarkPattern,
          matchMode,
          caseSensitive,
          layoutKey: choice.layoutKey ?? 'generic',
          profileFormType: choice.profileFormType,
          enabled,
          notes: notes.trim() === '' ? null : notes.trim(),
        }),
      });
      setBookmarkPattern('');
      setNotes('');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    }
  }

  async function patch(id: string, body: Partial<PageRule>): Promise<void> {
    try {
      await api(`/api/staff/admin/signature-config/page-rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'update_failed');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Delete this rule?')) return;
    try {
      await api(`/api/staff/admin/signature-config/page-rules/${id}`, {
        method: 'DELETE',
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete_failed');
    }
  }

  const groups = useMemo(() => {
    const byType = new Map<string, PageRule[]>();
    for (const rule of rules) {
      const list = byType.get(rule.formType) ?? [];
      list.push(rule);
      byType.set(rule.formType, list);
    }
    return Array.from(byType.entries())
      .map(([type, list]) => ({
        type,
        rules: list.sort((a, b) => a.sortOrder - b.sortOrder),
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }, [rules]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Signature page rules">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Locate the signature pages inside a tax-return PDF by matching PDF bookmarks. Each rule
          maps a bookmark to a signature-field layout, per return type. Defaults are seeded
          automatically.
        </p>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
        {canWrite && (
          <form
            onSubmit={create}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <div style={{ width: 150 }}>
              <Combobox
                ariaLabel="Form type"
                value={formTypeSel}
                onChange={setFormTypeSel}
                options={formTypeOptions()}
              />
            </div>
            {formTypeSel === CUSTOM_FORM_TYPE && (
              <Input
                value={customFormType}
                onChange={(e) => setCustomFormType(e.target.value)}
                placeholder="Custom form type"
                required
              />
            )}
            <Input
              value={bookmarkPattern}
              onChange={(e) => setBookmarkPattern(e.target.value)}
              placeholder="Bookmark pattern"
              required
            />
            <div style={{ width: 130 }}>
              <Combobox
                ariaLabel="Match mode"
                value={matchMode}
                onChange={(v) => setMatchMode(v as MatchMode)}
                options={MATCH_MODE_OPTIONS}
              />
            </div>
            <div style={{ width: 240 }}>
              <Combobox
                ariaLabel="Layout or profile"
                value={layoutChoice}
                onChange={setLayoutChoice}
                options={layoutChoiceOptions(profiles)}
              />
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              Case-sensitive
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enabled
            </label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (optional)"
            />
            <Button type="submit">Add rule</Button>
          </form>
        )}
        {loading && <p style={{ fontSize: 13 }}>Loading…</p>}
        {!loading && groups.length === 0 && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No rules yet.</p>
        )}
      </Card>

      {groups.map((g) => (
        <Card key={g.type} title={`Form ${g.type === '*' ? 'Any (*)' : g.type}`}>
          <Table<PageRule>
            columns={[
              {
                key: 'bookmark',
                header: 'Bookmark pattern',
                render: (r) => <code>{r.bookmarkPattern}</code>,
              },
              {
                key: 'matchMode',
                header: 'Match',
                render: (r) => (
                  <Pill>
                    {r.matchMode}
                    {r.caseSensitive ? ' (cs)' : ''}
                  </Pill>
                ),
              },
              {
                key: 'layout',
                header: 'Fields from',
                render: (r) =>
                  canWrite ? (
                    <div style={{ minWidth: 220 }}>
                      <Combobox
                        ariaLabel="Layout or profile"
                        value={choiceFromRule(r)}
                        onChange={(v) => void patch(r.id, patchFromChoice(v))}
                        options={layoutChoiceOptions(profiles)}
                      />
                    </div>
                  ) : r.profileFormType ? (
                    `Profile: ${r.profileFormType}`
                  ) : (
                    layoutLabel(r.layoutKey)
                  ),
              },
              {
                key: 'notes',
                header: 'Notes',
                render: (r) => r.notes ?? '—',
              },
              {
                key: 'enabled',
                header: 'Enabled',
                render: (r) => (
                  <input
                    type="checkbox"
                    aria-label="Enabled"
                    checked={r.enabled}
                    disabled={!canWrite}
                    onChange={() => void patch(r.id, { enabled: !r.enabled })}
                  />
                ),
              },
              {
                key: 'edit',
                header: '',
                align: 'right',
                render: (r) =>
                  canWrite ? (
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const next = prompt(
                            `Edit bookmark pattern for ${r.formType}:`,
                            r.bookmarkPattern,
                          );
                          if (next === null || next.trim() === r.bookmarkPattern) return;
                          void patch(r.id, { bookmarkPattern: next.trim() });
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void remove(r.id)}>
                        Delete
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
            rows={g.rules}
            rowKey={(r) => r.id}
          />
        </Card>
      ))}
    </div>
  );
}
