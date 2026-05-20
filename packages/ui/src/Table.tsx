// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { ReactNode } from 'react';

import { tokens } from './tokens';

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
}

export function Table<T>({ columns, rows, rowKey, empty }: TableProps<T>): JSX.Element {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: tokens.space.lg,
          textAlign: 'center',
          color: tokens.color.textMuted,
          fontFamily: tokens.font.body,
          fontSize: 13,
        }}
      >
        {empty ?? 'No data.'}
      </div>
    );
  }

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontFamily: tokens.font.body,
        fontSize: 13,
        color: tokens.color.text,
      }}
    >
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              style={{
                textAlign: c.align ?? 'left',
                padding: '8px 6px',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: tokens.color.textMuted,
                borderBottom: `1px solid ${tokens.color.border}`,
              }}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((c) => (
              <td
                key={c.key}
                style={{
                  textAlign: c.align ?? 'left',
                  padding: '10px 6px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : 'normal',
                }}
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
