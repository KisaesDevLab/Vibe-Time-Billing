// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Signature print rules (0187). Prioritized rules that decide,
// when a tax-return signature completes, what gets printed (built-in
// confirmation report or a Vibe Print gateway template) and where (a
// specific printer or the client office's printer). First match wins.

import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Rule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  formCodes: string[];
  engagementTypeIds: string[];
  templateSource: 'builtin' | 'gateway';
  gatewayTemplateId: number | null;
  printerMode: 'specific' | 'client_office';
  printerId: number | null;
  copies: number;
}
interface NamedNum {
  id: number;
  name: string;
}
interface NamedId {
  id: string;
  name: string;
}

interface Draft {
  name: string;
  priority: number;
  enabled: boolean;
  formCodes: string;
  engagementTypeIds: string[];
  templateSource: 'builtin' | 'gateway';
  gatewayTemplateId: number | '';
  printerMode: 'specific' | 'client_office';
  printerId: number | '';
  copies: number;
}

const emptyDraft: Draft = {
  name: '',
  priority: 100,
  enabled: true,
  formCodes: '',
  engagementTypeIds: [],
  templateSource: 'builtin',
  gatewayTemplateId: '',
  printerMode: 'specific',
  printerId: '',
  copies: 1,
};

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

const BASE = '/api/staff/admin/print-gateway';

export function SignaturePrintRulesPage(): JSX.Element {
  const [rules, setRules] = useState<Rule[]>([]);
  const [engagementTypes, setEngagementTypes] = useState<NamedId[]>([]);
  const [templates, setTemplates] = useState<NamedNum[]>([]);
  const [printers, setPrinters] = useState<NamedNum[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [r, et, tpl, pr] = await Promise.all([
        api<{ rules: Rule[] }>(`${BASE}/signature-print-rules`),
        api<{ items: NamedId[] }>('/api/staff/taxonomy/engagement-types').catch(() => ({
          items: [],
        })),
        api<{ templates: NamedNum[] }>(`${BASE}/gateway-templates`).catch(() => ({
          templates: [],
        })),
        api<{ printers: NamedNum[] }>('/api/staff/print/printers').catch(() => ({ printers: [] })),
      ]);
      setRules(r.rules ?? []);
      setEngagementTypes(et.items ?? []);
      setTemplates(tpl.templates ?? []);
      setPrinters(pr.printers ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function startCreate(): void {
    setDraft(emptyDraft);
    setEditingId(null);
    setOpen(true);
  }
  function startEdit(r: Rule): void {
    setDraft({
      name: r.name,
      priority: r.priority,
      enabled: r.enabled,
      formCodes: (r.formCodes ?? []).join(', '),
      engagementTypeIds: r.engagementTypeIds ?? [],
      templateSource: r.templateSource,
      gatewayTemplateId: r.gatewayTemplateId ?? '',
      printerMode: r.printerMode,
      printerId: r.printerId ?? '',
      copies: r.copies,
    });
    setEditingId(r.id);
    setOpen(true);
  }

  async function save(): Promise<void> {
    setErr(null);
    const body = {
      name: draft.name,
      priority: draft.priority,
      enabled: draft.enabled,
      formCodes: draft.formCodes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      engagementTypeIds: draft.engagementTypeIds,
      templateSource: draft.templateSource,
      gatewayTemplateId:
        draft.templateSource === 'gateway' && draft.gatewayTemplateId !== ''
          ? draft.gatewayTemplateId
          : null,
      printerMode: draft.printerMode,
      printerId:
        draft.printerMode === 'specific' && draft.printerId !== '' ? draft.printerId : null,
      copies: draft.copies,
    };
    try {
      if (editingId) {
        await api(`${BASE}/signature-print-rules/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await api(`${BASE}/signature-print-rules`, { method: 'POST', body: JSON.stringify(body) });
      }
      setOpen(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save_failed');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Delete this rule?')) return;
    try {
      await api(`${BASE}/signature-print-rules/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete_failed');
    }
  }

  const etName = (id: string): string => engagementTypes.find((e) => e.id === id)?.name ?? id;
  const tplName = (id: number | null): string =>
    id == null ? '' : (templates.find((t) => t.id === id)?.name ?? `#${id}`);
  const prName = (id: number | null): string =>
    id == null ? '' : (printers.find((p) => p.id === id)?.name ?? `#${id}`);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card
        title="Signature print rules"
        action={
          <Button size="sm" onClick={startCreate}>
            + New rule
          </Button>
        }
      >
        {err && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {err}
          </p>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
          When a tax-return signature completes, the first enabled rule (by priority) whose filters
          match decides what prints and where. Requires the gateway enabled and the master
          &ldquo;auto-print signature confirmation&rdquo; toggle on (Admin &rarr; Printing).
        </p>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {rules.length === 0 && (
            <p style={{ fontSize: 12, color: tokens.color.textMuted }}>No rules yet.</p>
          )}
          {rules.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                flexWrap: 'wrap',
                padding: 10,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
              }}
            >
              <span style={{ fontSize: 11, color: tokens.color.textMuted, width: 28 }}>
                {r.priority}
              </span>
              <strong style={{ fontSize: 13, minWidth: 140 }}>{r.name}</strong>
              {!r.enabled && <Pill>disabled</Pill>}
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                {(r.formCodes ?? []).length ? r.formCodes.join('/') : 'any form'} ·{' '}
                {(r.engagementTypeIds ?? []).length
                  ? r.engagementTypeIds.map(etName).join('/')
                  : 'any engagement'}
              </span>
              <span style={{ fontSize: 12 }}>
                →{' '}
                {r.templateSource === 'gateway'
                  ? `tmpl ${tplName(r.gatewayTemplateId)}`
                  : 'built-in report'}{' '}
                →{' '}
                {r.printerMode === 'client_office' ? 'client office printer' : prName(r.printerId)}
                {r.copies > 1 ? ` ×${r.copies}` : ''}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <Button size="sm" variant="ghost" onClick={() => startEdit(r)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(r.id)}>
                  Delete
                </Button>
              </span>
            </div>
          ))}
        </div>
      </Card>

      {open && (
        <Card title={editingId ? 'Edit rule' : 'New rule'}>
          <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
            <div style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Name
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
                Priority
                <input
                  type="number"
                  value={draft.priority}
                  onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) || 0 })}
                  style={{ ...fieldStyle, width: 90 }}
                />
              </label>
              <label
                style={{
                  fontSize: 13,
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  marginTop: 20,
                }}
              >
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                Enabled
              </label>
              <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
                Copies
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.copies}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      copies: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                    })
                  }
                  style={{ ...fieldStyle, width: 80 }}
                />
              </label>
            </div>

            <div style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Form codes (comma-separated; blank = any)
              <Input
                value={draft.formCodes}
                placeholder="1040, 1120-S"
                onChange={(e) => setDraft({ ...draft, formCodes: e.target.value })}
              />
            </div>

            <div style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Engagement types (none selected = any)
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  padding: 8,
                }}
              >
                {engagementTypes.length === 0 && (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    No engagement types.
                  </span>
                )}
                {engagementTypes.map((et) => {
                  const on = draft.engagementTypeIds.includes(et.id);
                  return (
                    <label
                      key={et.id}
                      style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            engagementTypeIds: e.target.checked
                              ? [...draft.engagementTypeIds, et.id]
                              : draft.engagementTypeIds.filter((x) => x !== et.id),
                          })
                        }
                      />
                      {et.name}
                    </label>
                  );
                })}
              </div>
            </div>

            <div style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Template
              <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="radio"
                  checked={draft.templateSource === 'builtin'}
                  onChange={() => setDraft({ ...draft, templateSource: 'builtin' })}
                />
                Built-in confirmation report
              </label>
              <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="radio"
                  checked={draft.templateSource === 'gateway'}
                  onChange={() => setDraft({ ...draft, templateSource: 'gateway' })}
                />
                Vibe Print template:
                <select
                  value={draft.gatewayTemplateId}
                  disabled={draft.templateSource !== 'gateway'}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      gatewayTemplateId: e.target.value ? Number(e.target.value) : '',
                    })
                  }
                  style={fieldStyle}
                >
                  <option value="">— pick a template —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} (#{t.id})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Printer
              <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="radio"
                  checked={draft.printerMode === 'specific'}
                  onChange={() => setDraft({ ...draft, printerMode: 'specific' })}
                />
                Specific printer:
                <select
                  value={draft.printerId}
                  disabled={draft.printerMode !== 'specific'}
                  onChange={(e) =>
                    setDraft({ ...draft, printerId: e.target.value ? Number(e.target.value) : '' })
                  }
                  style={fieldStyle}
                >
                  <option value="">— pick a printer —</option>
                  {printers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (#{p.id})
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="radio"
                  checked={draft.printerMode === 'client_office'}
                  onChange={() => setDraft({ ...draft, printerMode: 'client_office' })}
                />
                The client office&rsquo;s assigned printer
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => void save()}>
                {editingId ? 'Save changes' : 'Create rule'}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
