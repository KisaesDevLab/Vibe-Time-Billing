// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP0 — Mobile card-list fallback for the portal Files page. At <720px
// the file table becomes a stacked card with icon + name + size +
// download action. UI plan §4 — list patterns.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Button, Pill, tokens } from '@vibe/ui';

export interface FileCardRow {
  id: string;
  originalFilename: string;
  sizeBytes: number;
  mimeType: string | null;
  uploadedAt: string;
  categoryLabel?: string | null;
  /** Pre-resolved icon glyph (emoji). The caller already maps mime + ext. */
  icon: string;
  /** Disabled when pay-to-unlock is in effect for this row. */
  downloadDisabled?: boolean;
}

export interface FileCardListProps {
  rows: FileCardRow[];
  onDownload: (id: string) => void;
  empty?: ReactNode;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function FileCardList({ rows, onDownload, empty }: FileCardListProps): JSX.Element {
  if (rows.length === 0) {
    return <>{empty}</>;
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
      {rows.map((r) => (
        <li
          key={r.id}
          style={{
            padding: tokens.space.md,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            background: tokens.color.surface,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: tokens.space.md,
            alignItems: 'center',
          }}
        >
          <div style={{ fontSize: 24, lineHeight: 1 }} aria-hidden>
            {r.icon}
          </div>
          <div style={{ minWidth: 0 }}>
            <Link
              to={`/files/${r.id}`}
              style={{
                fontSize: 14,
                fontWeight: 500,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: 'block',
                color: tokens.color.accent,
                textDecoration: 'none',
              }}
            >
              {r.originalFilename}
            </Link>
            <div
              style={{
                fontSize: 12,
                color: tokens.color.textMuted,
                marginTop: 2,
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <span>{formatBytes(r.sizeBytes)}</span>
              <span>·</span>
              <span>{r.uploadedAt.slice(0, 10)}</span>
              {r.categoryLabel && <Pill tone="neutral">{r.categoryLabel}</Pill>}
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onDownload(r.id)}
            disabled={r.downloadDisabled}
          >
            Download
          </Button>
        </li>
      ))}
    </ul>
  );
}
