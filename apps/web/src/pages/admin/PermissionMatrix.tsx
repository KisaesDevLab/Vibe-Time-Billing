// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface PermissionRow {
  key: string;
  roles: string[];
}

interface MatrixResponse {
  permissions: PermissionRow[];
  roles: string[];
}

export function PermissionMatrixPage(): JSX.Element {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<MatrixResponse>('/api/staff/admin/permission-matrix');
        setData(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  if (error) return <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>;
  if (!data) return <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>;

  return (
    <Card title="Permission matrix (read-only)">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Each cell shows whether the role template grants the permission. Templates ship with the
        appliance and are referenced by user_role joins. Custom roles live in the `role` table and
        can grant any subset of these keys.
      </p>
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
                    fontFamily: 'monospace',
                    fontSize: 11,
                  }}
                >
                  {p.key}
                </td>
                {data.roles.map((r) => (
                  <td
                    key={r}
                    style={{
                      padding: '6px 12px',
                      textAlign: 'center',
                      borderBottom: `1px solid ${tokens.color.border}`,
                    }}
                  >
                    {p.roles.includes(r) ? <Pill tone="success">✓</Pill> : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
