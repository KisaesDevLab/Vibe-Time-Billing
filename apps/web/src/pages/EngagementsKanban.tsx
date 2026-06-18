// SPDX-License-Identifier: Elastic-2.0
//
// 0050 — kanban view over engagements.
//
// Columns derive from engagement_status_config (per-firm settings on top
// of the workflow_state pgEnum). Drag a card to a column → PATCH
// /workflow-state with optimistic update + rollback on error.
//
// Native HTML5 DnD keeps the bundle light. Touch isn't supported by the
// native API; on touch devices the per-row workflow combobox in the list
// view is the fallback path.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { allowedForServiceLine } from '../status-filter';

type WorkflowState =
  | 'NO_STATUS'
  | 'NOT_STARTED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'NEEDS_REVIEW'
  | 'WITH_CLIENT'
  | 'COMPLETED'
  | 'CANCELED'
  | 'DRAFT';

type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface EngagementKanbanRow {
  id: string;
  clientId: string;
  name: string;
  workflowState: WorkflowState;
  priority: Priority;
  clientName: string;
  // 0167 — the engagement's service line (resolved via its type), used to
  // gate which columns it may be dropped into. Null ⇒ no restriction.
  serviceLineId: string | null;
}

export interface StatusColumn {
  workflowState: WorkflowState;
  label: string;
  color: string;
  sortOrder: number;
  // 0167 — service lines this status applies to (empty ⇒ all).
  serviceLineIds: string[];
}

const PRIORITY_TONE: Record<Priority, 'neutral' | 'accent' | 'warning' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'accent',
  HIGH: 'warning',
  URGENT: 'danger',
};

export function EngagementsKanban({
  rows,
  columns,
  onMoved,
  onError,
}: {
  rows: EngagementKanbanRow[];
  columns: StatusColumn[];
  onMoved: (id: string, from: WorkflowState, to: WorkflowState) => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<WorkflowState | null>(null);
  // Optimistic overlay — rows whose workflowState we've moved client-side
  // but haven't reconciled yet. Keyed by engagement id.
  const [optimistic, setOptimistic] = useState<Record<string, WorkflowState>>({});

  const grouped = useMemo(() => {
    const map = new Map<WorkflowState, EngagementKanbanRow[]>();
    for (const c of columns) map.set(c.workflowState, []);
    for (const r of rows) {
      const ws = optimistic[r.id] ?? r.workflowState;
      const list = map.get(ws);
      if (list) list.push({ ...r, workflowState: ws });
    }
    return map;
  }, [rows, columns, optimistic]);

  async function handleDrop(target: WorkflowState): Promise<void> {
    if (!draggingId) return;
    const row = rows.find((r) => r.id === draggingId);
    if (!row) return;
    const from = optimistic[row.id] ?? row.workflowState;
    setDraggingId(null);
    setOverCol(null);
    if (from === target) return;
    // 0167 — block drops onto a status not mapped to this engagement's
    // service line (the column is also dimmed during drag).
    const targetCol = columns.find((c) => c.workflowState === target);
    if (targetCol && !allowedForServiceLine(targetCol, row.serviceLineId, from)) {
      onError('That status isn’t available for this engagement’s service line.');
      return;
    }
    setOptimistic((p) => ({ ...p, [row.id]: target }));
    try {
      await api(`/api/staff/engagements/${row.id}/workflow-state`, {
        method: 'PATCH',
        body: JSON.stringify({ workflowState: target }),
      });
      onMoved(row.id, from, target);
    } catch (err) {
      // Roll back the optimistic move.
      setOptimistic((p) => {
        const next = { ...p };
        delete next[row.id];
        return next;
      });
      onError(err instanceof Error ? err.message : 'workflow_update_failed');
    }
  }

  // 0167 — while a card is dragging, gate columns by its service line.
  const draggingRow = draggingId ? (rows.find((r) => r.id === draggingId) ?? null) : null;
  const colAllowed = (col: StatusColumn): boolean =>
    !draggingRow ||
    allowedForServiceLine(
      col,
      draggingRow.serviceLineId,
      optimistic[draggingRow.id] ?? draggingRow.workflowState,
    );

  if (columns.length === 0) {
    return (
      <p style={{ color: tokens.color.textMuted, fontSize: 13, padding: 12 }}>
        No status columns visible. Click the <strong>⚙ Columns</strong> button above to choose which
        statuses to show, or open <em>Admin → Engagement Statuses</em> to enable a column firm-wide.
      </p>
    );
  }

  return (
    // Wrapper pins the kanban to the Card's content width so the inner
    // scroll container has something concrete to overflow against.
    // `minWidth: 0` lets us shrink below the natural content width inside
    // flex/grid ancestors.
    <div style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          gap: 12,
          overflowX: 'auto',
          overflowY: 'visible',
          paddingBottom: 8,
          // Smooth scrollbar appearance on Firefox/macOS; harmless elsewhere.
          scrollbarWidth: 'thin',
        }}
      >
        {columns.map((col) => {
          const list = grouped.get(col.workflowState) ?? [];
          const allowed = colAllowed(col);
          const isOver = overCol === col.workflowState && allowed;
          return (
            <div
              key={col.workflowState}
              aria-disabled={!allowed}
              onDragOver={(e) => {
                if (!draggingId || !allowed) return;
                e.preventDefault();
                if (overCol !== col.workflowState) setOverCol(col.workflowState);
              }}
              onDragLeave={() => {
                if (overCol === col.workflowState) setOverCol(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (!allowed) return;
                void handleDrop(col.workflowState);
              }}
              style={{
                // Fixed width so the row overflows horizontally instead
                // of squeezing into the page width. No shrink, no grow.
                flex: '0 0 260px',
                background: tokens.color.surface,
                border: `2px solid ${isOver ? col.color : tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: 8,
                minHeight: 200,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                // Dim columns the dragging card can't move into.
                opacity: allowed ? 1 : 0.4,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '4px 6px',
                  borderBottom: `2px solid ${col.color}`,
                }}
              >
                <strong style={{ fontSize: 13, color: tokens.color.text }}>{col.label}</strong>
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{list.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {list.map((r) => (
                  <div
                    key={r.id}
                    draggable
                    onDragStart={() => setDraggingId(r.id)}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setOverCol(null);
                    }}
                    onClick={() => navigate(`/engagements/${r.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(`/engagements/${r.id}`);
                      }
                    }}
                    style={{
                      padding: '8px 10px',
                      background: tokens.color.bg,
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      cursor: 'grab',
                      fontSize: 13,
                      opacity: draggingId === r.id ? 0.4 : 1,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${r.name} — ${r.clientName}`}
                  >
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      {r.clientName}
                    </div>
                    <div>
                      <Pill tone={PRIORITY_TONE[r.priority]}>{r.priority}</Pill>
                    </div>
                  </div>
                ))}
                {list.length === 0 && (
                  <p
                    style={{
                      fontSize: 11,
                      color: tokens.color.textMuted,
                      margin: 0,
                      padding: '8px 0',
                      textAlign: 'center',
                    }}
                  >
                    Empty
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
