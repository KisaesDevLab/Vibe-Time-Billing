// SPDX-License-Identifier: Elastic-2.0
//
// CP0 — Mobile card-list fallback for the portal invoice table.
// At <720px the row layout becomes a stacked card so columns don't
// truncate or scroll horizontally. UI plan §4 — list patterns.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Pill, tokens } from '@vibe/ui';

export interface InvoiceCardRow {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string;
  totalCents: number;
  paidCents?: number;
  status: string;
}

export interface InvoiceCardListProps {
  rows: InvoiceCardRow[];
  /** Tone resolver mirroring the table's status column. */
  statusTone: (s: string) => 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
  /** Render when no rows. Pass an EmptyState or simple text. */
  empty?: ReactNode;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function InvoiceCardList({ rows, statusTone, empty }: InvoiceCardListProps): JSX.Element {
  if (rows.length === 0) {
    return <>{empty}</>;
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
      {rows.map((r) => {
        const balance = r.paidCents != null ? r.totalCents - r.paidCents : null;
        return (
          <li
            key={r.id}
            style={{
              padding: tokens.space.md,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <Link
                to={`/invoices/${r.id}`}
                style={{ color: tokens.color.accent, fontWeight: 600, fontSize: 14 }}
              >
                {r.invoiceNumber}
              </Link>
              <Pill tone={statusTone(r.status)}>{r.status}</Pill>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 6,
                fontSize: 13,
                color: tokens.color.textMuted,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span>
                Issued {r.issueDate}
                {r.dueDate && ` · due ${r.dueDate}`}
              </span>
              <span>{formatCents(r.totalCents)}</span>
            </div>
            {balance != null && balance > 0 && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 12,
                  color: tokens.color.danger,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatCents(balance)} outstanding
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
