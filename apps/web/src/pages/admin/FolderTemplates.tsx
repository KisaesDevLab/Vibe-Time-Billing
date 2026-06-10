// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin: client folder-structure templates. A template is a firm-level,
// ordered list of virtual folders that the Files tab unions under every
// client's root (empty until used). One template is the firm default; it
// applies to clients with no specific template assigned.
//
// Left panel: the template list (default Pill + set-default/delete). Right
// panel: the selected template's ordered items in a Table with visibility,
// enabled toggle, up/down reorder, and delete, plus an add-folder row.

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';

type Visibility = 'private' | 'client_visible' | null;

interface TemplateItem {
  id: string;
  name: string;
  visibility: Visibility;
  sortOrder: number;
  enabled: boolean;
}

interface FolderTemplate {
  id: string;
  name: string;
  isDefault: boolean;
  items: TemplateItem[];
}

// Combobox values are strings, so the null "default" visibility is encoded
// with a sentinel and converted back at the call site.
const VIS_DEFAULT = '__default__';
const VISIBILITY_OPTIONS = [
  { value: VIS_DEFAULT, label: 'Default (private)' },
  { value: 'private', label: 'Private' },
  { value: 'client_visible', label: 'Client-visible' },
];

function visToValue(v: Visibility): string {
  return v === null ? VIS_DEFAULT : v;
}

function valueToVis(value: string): Visibility {
  return value === VIS_DEFAULT ? null : (value as Exclude<Visibility, null>);
}

function visibilityLabel(v: Visibility): string {
  return VISIBILITY_OPTIONS.find((o) => o.value === visToValue(v))?.label ?? 'Default (private)';
}

export function FolderTemplatesPage(): JSX.Element {
  const canWrite = usePermission('firm:settings:write');
  const [templates, setTemplates] = useState<FolderTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [newTemplateName, setNewTemplateName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderVis, setNewFolderVis] = useState<string>(VIS_DEFAULT);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ templates: FolderTemplate[] }>('/api/staff/admin/folder-templates');
      const list = r.templates ?? [];
      setTemplates(list);
      // Keep the current selection if it still exists; else pick the default
      // (or the first template).
      setSelectedId((prev) => {
        if (prev && list.some((t) => t.id === prev)) return prev;
        return (list.find((t) => t.isDefault) ?? list[0])?.id ?? null;
      });
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

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const sortedItems = useMemo(
    () => (selected ? [...selected.items].sort((a, b) => a.sortOrder - b.sortOrder) : []),
    [selected],
  );

  async function createTemplate(e: FormEvent): Promise<void> {
    e.preventDefault();
    const name = newTemplateName.trim();
    if (!name) return;
    try {
      const r = await api<{ template: FolderTemplate }>('/api/staff/admin/folder-templates', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setNewTemplateName('');
      if (r.template?.id) setSelectedId(r.template.id);
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    }
  }

  async function renameTemplate(t: FolderTemplate): Promise<void> {
    const next = prompt(`Rename template "${t.name}":`, t.name);
    if (next === null || next.trim() === '' || next.trim() === t.name) return;
    try {
      await api(`/api/staff/admin/folder-templates/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next.trim() }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'rename_failed');
    }
  }

  async function setDefault(t: FolderTemplate): Promise<void> {
    try {
      await api(`/api/staff/admin/folder-templates/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'set_default_failed');
    }
  }

  async function deleteTemplate(t: FolderTemplate): Promise<void> {
    if (!confirm(`Delete template "${t.name}"? Folders defined here will no longer appear.`)) {
      return;
    }
    try {
      await api(`/api/staff/admin/folder-templates/${t.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'delete_failed';
      setErr(
        msg.includes('cannot_delete_default')
          ? 'This is the firm default template and cannot be deleted. Set another template as default first.'
          : msg,
      );
    }
  }

  async function addFolder(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!selected) return;
    const name = newFolderName.trim();
    if (!name) return;
    const sortOrder = sortedItems.length ? Math.max(...sortedItems.map((i) => i.sortOrder)) + 1 : 0;
    try {
      await api(`/api/staff/admin/folder-templates/${selected.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ name, visibility: valueToVis(newFolderVis), sortOrder }),
      });
      setNewFolderName('');
      setNewFolderVis(VIS_DEFAULT);
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'add_folder_failed');
    }
  }

  async function patchItem(item: TemplateItem, body: Partial<TemplateItem>): Promise<void> {
    try {
      await api(`/api/staff/admin/folder-templates/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'update_failed');
    }
  }

  async function deleteItem(item: TemplateItem): Promise<void> {
    if (!confirm(`Remove folder "${item.name}" from this template?`)) return;
    try {
      await api(`/api/staff/admin/folder-templates/items/${item.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete_failed');
    }
  }

  // Swap a row with its neighbour by exchanging sortOrders, then reorder.
  async function move(item: TemplateItem, dir: -1 | 1): Promise<void> {
    if (!selected) return;
    const idx = sortedItems.findIndex((i) => i.id === item.id);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sortedItems.length) return;
    const other = sortedItems[swapIdx]!;
    try {
      await api(`/api/staff/admin/folder-templates/${selected.id}/items/reorder`, {
        method: 'POST',
        body: JSON.stringify({
          order: [
            { id: item.id, sortOrder: other.sortOrder },
            { id: other.id, sortOrder: item.sortOrder },
          ],
        }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'reorder_failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Client folder templates">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Folders are shown under every client&apos;s root in the Files tab (empty until used); the
          default template applies to clients with no specific template assigned.
        </p>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
        {loading && <p style={{ fontSize: 13 }}>Loading…</p>}
      </Card>

      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: tokens.space.lg }}>
          <Card title="Templates">
            {canWrite && (
              <form onSubmit={createTemplate} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <Input
                  value={newTemplateName}
                  onChange={(e) => setNewTemplateName(e.target.value)}
                  placeholder="New template"
                />
                <Button type="submit" disabled={newTemplateName.trim() === ''}>
                  Add
                </Button>
              </form>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {templates.map((t) => {
                const active = t.id === selectedId;
                return (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      padding: '8px 10px',
                      borderRadius: tokens.radius.sm,
                      background: active ? tokens.color.accentMuted : 'transparent',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(t.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: 13,
                        color: active ? tokens.color.accent : tokens.color.text,
                      }}
                    >
                      <span style={{ fontWeight: active ? 600 : 400 }}>{t.name}</span>
                      {t.isDefault && <Pill tone="success">Default</Pill>}
                    </button>
                    {canWrite && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <Button size="sm" variant="ghost" onClick={() => void renameTemplate(t)}>
                          Rename
                        </Button>
                        {!t.isDefault && (
                          <Button size="sm" variant="ghost" onClick={() => void setDefault(t)}>
                            Set default
                          </Button>
                        )}
                        {!t.isDefault && (
                          <Button size="sm" variant="ghost" onClick={() => void deleteTemplate(t)}>
                            Delete
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {templates.length === 0 && (
                <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No templates yet.</p>
              )}
            </div>
          </Card>

          <Card title={selected ? `Folders — ${selected.name}` : 'Folders'}>
            {!selected && (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
                Select a template to edit its folders.
              </p>
            )}
            {selected && (
              <>
                {canWrite && (
                  <form
                    onSubmit={addFolder}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}
                  >
                    <Input
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="Folder name"
                      style={{ flex: 1 }}
                    />
                    <div style={{ width: 180 }}>
                      <Combobox
                        ariaLabel="New folder visibility"
                        value={newFolderVis}
                        onChange={setNewFolderVis}
                        options={VISIBILITY_OPTIONS}
                      />
                    </div>
                    <Button type="submit" disabled={newFolderName.trim() === ''}>
                      Add folder
                    </Button>
                  </form>
                )}
                <Table<TemplateItem>
                  rows={sortedItems}
                  rowKey={(r) => r.id}
                  empty="No folders in this template yet."
                  columns={[
                    { key: 'name', header: 'Folder', render: (r) => r.name },
                    {
                      key: 'visibility',
                      header: 'Visibility',
                      render: (r) =>
                        canWrite ? (
                          <div style={{ width: 180 }}>
                            <Combobox
                              ariaLabel={`Visibility for ${r.name}`}
                              value={visToValue(r.visibility)}
                              onChange={(v) => void patchItem(r, { visibility: valueToVis(v) })}
                              options={VISIBILITY_OPTIONS}
                            />
                          </div>
                        ) : (
                          visibilityLabel(r.visibility)
                        ),
                    },
                    {
                      key: 'enabled',
                      header: 'Enabled',
                      render: (r) => (
                        <input
                          type="checkbox"
                          aria-label={`Enabled: ${r.name}`}
                          checked={r.enabled}
                          disabled={!canWrite}
                          onChange={() => void patchItem(r, { enabled: !r.enabled })}
                        />
                      ),
                    },
                    {
                      key: 'order',
                      header: 'Order',
                      render: (r) =>
                        canWrite ? (
                          <span style={{ display: 'inline-flex', gap: 4 }}>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Move ${r.name} up`}
                              disabled={sortedItems[0]?.id === r.id}
                              onClick={() => void move(r, -1)}
                            >
                              ↑
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Move ${r.name} down`}
                              disabled={sortedItems[sortedItems.length - 1]?.id === r.id}
                              onClick={() => void move(r, 1)}
                            >
                              ↓
                            </Button>
                          </span>
                        ) : null,
                    },
                    {
                      key: 'edit',
                      header: '',
                      align: 'right',
                      render: (r) =>
                        canWrite ? (
                          <Button size="sm" variant="ghost" onClick={() => void deleteItem(r)}>
                            Delete
                          </Button>
                        ) : null,
                    },
                  ]}
                />
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
