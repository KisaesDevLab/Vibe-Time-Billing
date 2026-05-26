// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 — single-candidate row inside LinkFolderModal.

import { Pill, tokens } from '@vibe/ui';
import { ConfidenceBar } from './ConfidenceBar';

export interface MatchCandidate {
  storage_path: string;
  confidence: number;
  reason_code: string | null;
  reason_text: string;
  status: 'unbound' | 'bound_to_self' | 'bound_to_other';
  bound_to?: { client_id: string; client_name: string };
  file_count: number;
  size_bytes: number;
  last_modified: string;
}

interface Props {
  candidate: MatchCandidate;
  isBest: boolean;
  canReconcile: boolean;
  onLink: () => void;
  busy: boolean;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function statusTone(s: MatchCandidate['status']): 'success' | 'warning' | 'neutral' {
  if (s === 'bound_to_other') return 'warning';
  if (s === 'bound_to_self') return 'success';
  return 'neutral';
}

export function CandidateCard({
  candidate,
  isBest,
  canReconcile,
  onLink,
  busy,
}: Props): JSX.Element {
  const disabled = candidate.status === 'bound_to_other' || busy;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        padding: 12,
        background:
          candidate.status === 'bound_to_other' ? 'rgba(255, 170, 0, 0.06)' : tokens.color.surface,
        border: isBest ? `2px solid ${tokens.color.accent}` : `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        alignItems: 'start',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          {isBest && <Pill tone="success">Best match</Pill>}
          <code
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 13,
              color: tokens.color.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {candidate.storage_path}
          </code>
          <Pill tone={statusTone(candidate.status)}>
            {candidate.status === 'unbound'
              ? 'Unbound'
              : candidate.status === 'bound_to_self'
                ? 'Already linked'
                : `Bound to ${candidate.bound_to?.client_name ?? 'another client'}`}
          </Pill>
        </div>
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 8 }}>
          {candidate.reason_text}
        </div>
        <ConfidenceBar confidence={candidate.confidence} />
        <div
          style={{
            fontSize: 11,
            color: tokens.color.textMuted,
            marginTop: 6,
            display: 'flex',
            gap: 12,
          }}
        >
          <span>{candidate.file_count} files</span>
          <span>{humanBytes(candidate.size_bytes)}</span>
          <span>Modified {new Date(candidate.last_modified).toLocaleDateString()}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <button
          type="button"
          onClick={onLink}
          disabled={disabled}
          style={{
            padding: '6px 12px',
            background: disabled ? tokens.color.border : tokens.color.accent,
            color: 'white',
            border: 'none',
            borderRadius: tokens.radius.sm,
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 13,
          }}
          title={
            candidate.status === 'bound_to_other'
              ? `Already bound to ${candidate.bound_to?.client_name ?? 'another client'}`
              : undefined
          }
        >
          {candidate.status === 'bound_to_self' ? 'Already linked' : 'Link'}
        </button>
        {candidate.status === 'bound_to_other' && canReconcile && (
          <a
            href={`/admin/storage/conflicts?path=${encodeURIComponent(candidate.storage_path)}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11, color: tokens.color.accent }}
          >
            Open in admin
          </a>
        )}
      </div>
    </div>
  );
}
