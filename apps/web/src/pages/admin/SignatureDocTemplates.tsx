// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin: firm default documents appended to a signing package, per return type.
// This is a library CRUD only — precise field placement is out of scope; absent
// fields a default signature+date is placed on the last page.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api, getCsrfToken } from '../../api-client';
import { usePermission } from '../../auth-context';

interface DocTemplate {
  id: string;
  formType: string;
  name: string;
  totalPages: number;
  fields: unknown | null;
  autoInclude: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
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

// Raw PDF upload — bypasses the JSON api() wrapper (the endpoint reads an
// application/pdf body with name + formType as query params).
async function uploadTemplate(name: string, formType: string, file: File): Promise<{ id: string }> {
  const csrf = getCsrfToken();
  const qs = `name=${encodeURIComponent(name)}&formType=${encodeURIComponent(formType)}`;
  const res = await fetch(`/api/staff/admin/signature-config/doc-templates?${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: file,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `upload_failed_${res.status}`);
  }
  return (await res.json()) as { id: string };
}

export function SignatureDocTemplatesPage(): JSX.Element {
  const canWrite = usePermission('firm:settings:write');
  const [templates, setTemplates] = useState<DocTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Upload form state.
  const [name, setName] = useState('');
  const [formTypeSel, setFormTypeSel] = useState<string>('1040');
  const [customFormType, setCustomFormType] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const formType = formTypeSel === CUSTOM_FORM_TYPE ? customFormType.trim() : formTypeSel;

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ templates: DocTemplate[] }>(
        '/api/staff/admin/signature-config/doc-templates',
      );
      setTemplates(r.templates ?? []);
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

  async function upload(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (name.trim() === '') {
      setErr('name_required');
      return;
    }
    if (formType === '') {
      setErr('form_type_required');
      return;
    }
    if (!file) {
      setErr('file_required');
      return;
    }
    setBusy(true);
    try {
      await uploadTemplate(name.trim(), formType, file);
      setName('');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'upload_failed');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Partial<DocTemplate>): Promise<void> {
    try {
      await api(`/api/staff/admin/signature-config/doc-templates/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'update_failed');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Delete this document template?')) return;
    try {
      await api(`/api/staff/admin/signature-config/doc-templates/${id}`, {
        method: 'DELETE',
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete_failed');
    }
  }

  const groups = useMemo(() => {
    const byType = new Map<string, DocTemplate[]>();
    for (const tpl of templates) {
      const list = byType.get(tpl.formType) ?? [];
      list.push(tpl);
      byType.set(tpl.formType, list);
    }
    return Array.from(byType.entries())
      .map(([type, list]) => ({
        type,
        templates: list.sort((a, b) => a.sortOrder - b.sortOrder),
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }, [templates]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Signature documents">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Firm default documents appended to a signing package, per return type. Optional precise
          field placement can be added later; without it, a default signature+date is placed on the
          last page.
        </p>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
        {canWrite && (
          <form
            onSubmit={upload}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Document name"
              required
            />
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
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: 13 }}
            />
            <Button type="submit" disabled={busy}>
              {busy ? 'Uploading…' : 'Upload'}
            </Button>
          </form>
        )}
        {loading && <p style={{ fontSize: 13 }}>Loading…</p>}
        {!loading && groups.length === 0 && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No document templates yet.</p>
        )}
      </Card>

      {groups.map((g) => (
        <Card key={g.type} title={`Form ${g.type === '*' ? 'Any (*)' : g.type}`}>
          <Table<DocTemplate>
            columns={[
              { key: 'name', header: 'Name', render: (r) => r.name },
              {
                key: 'pages',
                header: 'Pages',
                render: (r) => r.totalPages,
              },
              {
                key: 'fields',
                header: 'Fields',
                render: (r) => (r.fields ? <Pill>placed</Pill> : <Pill>default</Pill>),
              },
              {
                key: 'autoInclude',
                header: 'Auto-include',
                render: (r) => (
                  <input
                    type="checkbox"
                    aria-label="Auto-include"
                    checked={r.autoInclude}
                    disabled={!canWrite}
                    onChange={() => void patch(r.id, { autoInclude: !r.autoInclude })}
                  />
                ),
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
                key: 'actions',
                header: '',
                align: 'right',
                render: (r) => (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        window.open(
                          `/api/staff/admin/signature-config/doc-templates/${r.id}/source`,
                          '_blank',
                          'noopener,noreferrer',
                        )
                      }
                    >
                      Preview
                    </Button>
                    {canWrite && (
                      <Button size="sm" variant="ghost" onClick={() => void remove(r.id)}>
                        Delete
                      </Button>
                    )}
                  </span>
                ),
              },
            ]}
            rows={g.templates}
            rowKey={(r) => r.id}
          />
        </Card>
      ))}
    </div>
  );
}
