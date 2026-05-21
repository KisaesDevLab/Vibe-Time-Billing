// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Role {
  id: string;
  name: string;
  systemFlag: boolean;
}

interface PermissionMatrixEntry {
  key: string;
  roles: string[];
}

export function RolesPage(): JSX.Element {
  const [items, setItems] = useState<Role[]>([]);
  const [allPerms, setAllPerms] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [r, p] = await Promise.all([
        api<{ roles: Role[] }>('/api/staff/admin/roles'),
        api<{ permissions: PermissionMatrixEntry[]; roles: string[] }>(
          '/api/staff/admin/permission-matrix',
        ),
      ]);
      setItems(r.roles ?? []);
      setAllPerms(p.permissions.map((x) => x.key));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/staff/admin/roles', {
        method: 'POST',
        body: JSON.stringify({ name: newName, permissionKeys: [] }),
      });
      setNewName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function edit(id: string): Promise<void> {
    try {
      const r = await api<{ permissions: string[] }>(`/api/staff/admin/roles/${id}/permissions`);
      setEditPerms(new Set(r.permissions));
      setEditingId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  function togglePerm(k: string): void {
    const next = new Set(editPerms);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setEditPerms(next);
  }

  async function savePerms(): Promise<void> {
    if (!editingId) return;
    try {
      await api(`/api/staff/admin/roles/${editingId}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissionKeys: Array.from(editPerms) }),
      });
      setEditingId(null);
      setEditPerms(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Delete this custom role?')) return;
    try {
      await api(`/api/staff/admin/roles/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Add custom role">
        <form
          onSubmit={create}
          style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12 }}
        >
          <Input
            label="Role name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <Button type="submit" style={{ alignSelf: 'end' }}>
            Create
          </Button>
        </form>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 8 }}>
          The 5 system roles (admin/partner/manager/senior/staff) cannot be edited or deleted.
          Custom roles let you grant any subset of the permission catalog.
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      </Card>

      <Card title={`Roles (${items.length})`}>
        <Table<Role>
          columns={[
            { key: 'name', header: 'Name', render: (r) => r.name },
            {
              key: 'kind',
              header: 'Kind',
              render: (r) =>
                r.systemFlag ? <Pill tone="accent">system</Pill> : <Pill>custom</Pill>,
            },
            {
              key: 'actions',
              header: '',
              render: (r) =>
                r.systemFlag ? (
                  <span style={{ fontSize: 11, color: tokens.color.textMuted }}>read-only</span>
                ) : (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <Button size="sm" variant="secondary" onClick={() => void edit(r.id)}>
                      Permissions
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void remove(r.id)}>
                      Delete
                    </Button>
                  </span>
                ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No roles."
        />
      </Card>

      {editingId && (
        <Card title="Edit role permissions">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {allPerms.map((p) => (
              <label
                key={p}
                style={{
                  fontSize: 11,
                  fontFamily: 'monospace',
                  padding: '4px 8px',
                  borderRadius: tokens.radius.pill,
                  border: `1px solid ${editPerms.has(p) ? tokens.color.accent : tokens.color.border}`,
                  cursor: 'pointer',
                  background: editPerms.has(p) ? tokens.color.accent + '20' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={editPerms.has(p)}
                  onChange={() => togglePerm(p)}
                  style={{ marginRight: 6 }}
                />
                {p}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => void savePerms()}>Save permissions</Button>
            <Button variant="secondary" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
