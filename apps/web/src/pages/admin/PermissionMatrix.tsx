// SPDX-License-Identifier: Elastic-2.0
//
// 0147 — editable permission matrix. The admin column is fixed (always
// every key); every other cell is a click-to-toggle button: ✓ pill =
// granted, ✗ pill = not granted. Toggles persist as per-firm overrides
// on top of the shipped role templates; a dot marks cells that differ
// from the template default. Optimistic update, reverts on error.

import { useEffect, useState } from 'react';

import { Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface PermissionRow {
  key: string;
  roles: string[];
  overridden: string[];
}

interface MatrixResponse {
  permissions: PermissionRow[];
  roles: string[];
}

export function PermissionMatrixPage(): JSX.Element {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyCell, setBusyCell] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<MatrixResponse>('/api/staff/admin/permission-matrix');
      setData(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(key: string, role: string, currentlyGranted: boolean): Promise<void> {
    if (!data) return;
    const cell = `${role}:${key}`;
    setBusyCell(cell);
    // Optimistic flip; load() afterwards trues up the overridden markers.
    setData((prev) =>
      prev
        ? {
            ...prev,
            permissions: prev.permissions.map((p) =>
              p.key === key
                ? {
                    ...p,
                    roles: currentlyGranted
                      ? p.roles.filter((r) => r !== role)
                      : [...p.roles, role],
                  }
                : p,
            ),
          }
        : prev,
    );
    try {
      await api('/api/staff/admin/permission-matrix', {
        method: 'PUT',
        body: JSON.stringify({ role, key, granted: !currentlyGranted }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      await load(); // revert the optimistic flip
    } finally {
      setBusyCell(null);
    }
  }

  if (error && !data) return <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>;
  if (!data) return <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>;

  return (
    <Card title="Permission matrix">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Click a cell to grant (✓) or revoke (✗) a permission for that role. Changes apply to
        everyone holding the role and take effect immediately. The admin column is fixed — admins
        always hold every permission. A dot (•) marks cells changed from the shipped default.
      </p>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
          {error}
        </p>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
            fontFamily: tokens.font.body,
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  color: tokens.color.textMuted,
                  fontWeight: 500,
                }}
              >
                Permission
              </th>
              {data.roles.map((r) => (
                <th
                  key={r}
                  style={{
                    textAlign: 'center',
                    padding: '8px 12px',
                    borderBottom: `1px solid ${tokens.color.border}`,
                    color: tokens.color.textMuted,
                    fontWeight: 500,
                  }}
                >
                  {r}
                  {r === 'admin' && (
                    <span
                      title="Admins always hold every permission"
                      style={{ marginLeft: 4, fontSize: 10 }}
                    >
                      🔒
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.permissions.map((p) => (
              <tr key={p.key}>
                <td
                  style={{
                    padding: '6px 12px',
                    borderBottom: `1px solid ${tokens.color.border}`,
                    fontFamily: tokens.font.mono,
                    fontSize: 11,
                  }}
                >
                  {p.key}
                </td>
                {data.roles.map((r) => {
                  const granted = p.roles.includes(r);
                  const isOverride = p.overridden?.includes(r) ?? false;
                  const cellId = `${r}:${p.key}`;
                  return (
                    <td
                      key={r}
                      style={{
                        padding: '4px 12px',
                        textAlign: 'center',
                        borderBottom: `1px solid ${tokens.color.border}`,
                      }}
                    >
                      {r === 'admin' ? (
                        <Pill tone="success">✓</Pill>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void toggle(p.key, r, granted)}
                          disabled={busyCell === cellId}
                          aria-label={`${granted ? 'Revoke' : 'Grant'} ${p.key} for ${r}`}
                          title={
                            isOverride
                              ? 'Changed from default — click to toggle'
                              : 'Click to toggle'
                          }
                          style={{
                            background: 'transparent',
                            border: 'none',
                            padding: 0,
                            cursor: busyCell === cellId ? 'wait' : 'pointer',
                            opacity: busyCell === cellId ? 0.5 : 1,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                          }}
                        >
                          {granted ? <Pill tone="success">✓</Pill> : <Pill tone="neutral">✗</Pill>}
                          {isOverride && (
                            <span
                              aria-hidden
                              style={{ color: tokens.color.accent, fontSize: 14, lineHeight: 1 }}
                            >
                              •
                            </span>
                          )}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
