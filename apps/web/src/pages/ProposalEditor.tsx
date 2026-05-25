// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4b — Proposal editor with dnd-kit drag/drop, debounced autosave,
// validation pipeline, and undo/redo.
//
// Layout (unchanged from PP4a):
//   Left:  block list with drag-handle + inline editor on selection.
//          Add-block palette at top.
//   Right: live preview of the rendered tree.
//
// PP4b additions vs PP4a:
//   • dnd-kit SortableContext on the block list (replaces up/down
//     buttons; keyboard sortable still works via dnd-kit's
//     KeyboardSensor)
//   • useAutosave: 2 s debounce; queues during in-flight saves
//   • useUndoHistory + useUndoKeyboard: Cmd/Ctrl-Z + Shift-Z
//   • validateTree runs on every tree change; per-block errors
//     render inline on each row
//
// Block types here: text / heading / divider. P05 ships the
// remaining seven; the registry pattern is the same.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Button, Card, Input, Pill, SectionHeading, tokens } from '@vibe/ui';
import {
  addBlock,
  duplicateBlock,
  EMPTY_BLOCK_TREE,
  isBlockTree,
  removeBlock,
  reorderBlocks,
  updateBlock,
  validateTree,
  type ProposalBlock,
  type ProposalBlockTree,
} from '@vibe/core/proposals';

import { api } from '../api-client';
import { useAutosave, type SaveStatus } from '../proposal-editor/use-autosave';
import { useUndoHistory, useUndoKeyboard } from '../proposal-editor/use-undo-history';
import { VALIDATORS } from '../proposal-editor/block-validators';

interface ProposalDetail {
  proposal: {
    id: string;
    title: string;
    status: string;
    brochureJsonb: ProposalBlockTree | Record<string, unknown>;
    draftRevision: number;
    updatedAt: string;
  };
}

interface BlockTypeDef {
  type: string;
  label: string;
  icon: string;
  defaultProps: () => Record<string, unknown>;
  EditorFields: (props: {
    block: ProposalBlock;
    onChange: (next: Partial<Omit<ProposalBlock, 'id'>>) => void;
  }) => JSX.Element;
  Renderer: (props: { block: ProposalBlock }) => JSX.Element;
}

const TEXT_BLOCK: BlockTypeDef = {
  type: 'text',
  label: 'Text',
  icon: '¶',
  defaultProps: () => ({ md: '' }),
  EditorFields: ({ block, onChange }) => (
    <textarea
      value={String(block.props['md'] ?? '')}
      onChange={(e) => onChange({ props: { ...block.props, md: e.target.value } })}
      rows={8}
      style={{
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12,
        padding: 10,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
        color: tokens.color.text,
        width: '100%',
        resize: 'vertical',
      }}
      placeholder="Markdown body"
    />
  ),
  Renderer: ({ block }) => (
    <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{String(block.props['md'] ?? '')}</p>
  ),
};

const HEADING_BLOCK: BlockTypeDef = {
  type: 'heading',
  label: 'Heading',
  icon: 'H',
  defaultProps: () => ({ text: '', level: 1 }),
  EditorFields: ({ block, onChange }) => (
    <div style={{ display: 'grid', gap: 8 }}>
      <Input
        value={String(block.props['text'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, text: e.target.value } })}
        placeholder="Heading text"
      />
      <div style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3].map((lvl) => (
          <button
            key={lvl}
            type="button"
            onClick={() => onChange({ props: { ...block.props, level: lvl } })}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: tokens.radius.sm,
              border: `1px solid ${
                Number(block.props['level']) === lvl ? tokens.color.accent : tokens.color.border
              }`,
              background:
                Number(block.props['level']) === lvl
                  ? tokens.color.accentMuted
                  : tokens.color.surface,
              color: Number(block.props['level']) === lvl ? tokens.color.accent : tokens.color.text,
              cursor: 'pointer',
            }}
          >
            H{lvl}
          </button>
        ))}
      </div>
    </div>
  ),
  Renderer: ({ block }) => {
    const text = String(block.props['text'] ?? '');
    const level = Number(block.props['level'] ?? 1);
    const sizes: Record<number, string> = { 1: '26px', 2: '20px', 3: '16px' };
    return (
      <div
        style={{ fontSize: sizes[level] ?? '16px', fontWeight: 700, margin: 0 }}
        aria-level={level}
        role="heading"
      >
        {text || <span style={{ color: tokens.color.textMuted }}>(empty heading)</span>}
      </div>
    );
  },
};

const DIVIDER_BLOCK: BlockTypeDef = {
  type: 'divider',
  label: 'Divider',
  icon: '─',
  defaultProps: () => ({}),
  EditorFields: () => (
    <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
      Horizontal divider. No props to configure.
    </p>
  ),
  Renderer: () => (
    <hr
      style={{
        border: 0,
        borderTop: `1px solid ${tokens.color.border}`,
        margin: '8px 0',
        width: '100%',
      }}
    />
  ),
};

const REGISTRY = new Map<string, BlockTypeDef>([
  [TEXT_BLOCK.type, TEXT_BLOCK],
  [HEADING_BLOCK.type, HEADING_BLOCK],
  [DIVIDER_BLOCK.type, DIVIDER_BLOCK],
]);

function generateId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function coerceTree(raw: unknown): ProposalBlockTree {
  if (isBlockTree(raw)) return raw;
  return EMPTY_BLOCK_TREE;
}

function statusLabel(s: SaveStatus, last: Date | null): string {
  switch (s) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return last ? `Saved ${last.toLocaleTimeString()}` : 'Saved';
    case 'pending':
      return 'Unsaved changes';
    case 'error':
      return 'Save failed';
    default:
      return 'No changes';
  }
}

const STATUS_TONE: Record<SaveStatus, 'accent' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  idle: 'neutral',
  pending: 'warning',
  saving: 'accent',
  saved: 'success',
  error: 'danger',
};

const serializeTree = (t: ProposalBlockTree): string => JSON.stringify(t);

export function ProposalEditorPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const [detail, setDetail] = useState<ProposalDetail['proposal'] | null>(null);
  const [baseline, setBaseline] = useState<ProposalBlockTree>(EMPTY_BLOCK_TREE);
  const undo = useUndoHistory<ProposalBlockTree>(EMPTY_BLOCK_TREE, serializeTree);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<ProposalDetail>(`/api/staff/proposals/${id}`);
      setDetail(r.proposal);
      const tree = coerceTree(r.proposal.brochureJsonb);
      undo.reset(tree);
      setBaseline(tree);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const tree = undo.state;
  const setTree = useCallback((next: ProposalBlockTree) => undo.setState(next), [undo]);

  useUndoKeyboard({ undo: undo.undo, redo: undo.redo });

  const save = useCallback(
    async (next: ProposalBlockTree) => {
      const r = await api<{ draftRevision: number }>(`/api/staff/proposals/${id}/brochure`, {
        method: 'POST',
        body: JSON.stringify({ brochureJsonb: next }),
      });
      // Update baseline + reflect new revision in detail so dirty
      // diff resets correctly.
      setBaseline(next);
      setDetail((d) => (d ? { ...d, brochureJsonb: next, draftRevision: r.draftRevision } : d));
    },
    [id],
  );

  const autosave = useAutosave<ProposalBlockTree>(tree, baseline, save, 2000);

  const errors = useMemo(() => validateTree(tree, VALIDATORS), [tree]);
  const errorsByBlockId = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of errors) {
      const arr = m.get(e.blockId) ?? [];
      arr.push(e.message);
      m.set(e.blockId, arr);
    }
    return m;
  }, [errors]);

  function addNew(type: string): void {
    const def = REGISTRY.get(type);
    if (!def) return;
    const newBlock: ProposalBlock = {
      id: generateId(),
      type,
      position: tree.blocks.length,
      props: def.defaultProps(),
    };
    setTree(addBlock(tree, newBlock));
    setSelectedId(newBlock.id);
  }

  const sortedBlocks = useMemo(
    () => [...tree.blocks].sort((a, b) => a.position - b.position),
    [tree],
  );

  // dnd-kit sensors. Pointer for mouse/touch; keyboard so the
  // accessibility story stays sound.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = sortedBlocks.findIndex((b) => b.id === active.id);
    const toIndex = sortedBlocks.findIndex((b) => b.id === over.id);
    if (fromIndex === -1 || toIndex === -1) return;
    setTree(reorderBlocks(tree, fromIndex, toIndex));
  }

  if (!detail) {
    return (
      <div style={{ padding: tokens.space.lg }}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          {loadErr ?? 'Loading proposal…'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400 }}>
      <SectionHeading
        title={detail.title}
        description={
          <span>
            <Link to="/proposals" style={{ color: tokens.color.accent }}>
              ← All proposals
            </Link>{' '}
            · Status <Pill>{detail.status}</Pill> · v{detail.draftRevision} ·{' '}
            <Pill tone={STATUS_TONE[autosave.status]}>
              {statusLabel(autosave.status, autosave.lastSavedAt)}
            </Pill>
            {errors.length > 0 && (
              <>
                {' '}
                · <Pill tone="danger">{errors.length} validation issue(s)</Pill>
              </>
            )}
          </span>
        }
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="ghost" disabled={!undo.canUndo} onClick={() => undo.undo()}>
              Undo
            </Button>
            <Button size="sm" variant="ghost" disabled={!undo.canRedo} onClick={() => undo.redo()}>
              Redo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={autosave.status === 'saving'}
              onClick={() => void autosave.flush()}
            >
              Save now
            </Button>
          </div>
        }
      />
      {(loadErr || autosave.lastError) && (
        <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>
          {loadErr ?? autosave.lastError?.message}
        </p>
      )}

      <Card>
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Add block:</span>
          {Array.from(REGISTRY.values()).map((def) => (
            <Button key={def.type} size="sm" variant="ghost" onClick={() => addNew(def.type)}>
              <span aria-hidden style={{ marginRight: 4, fontFamily: 'ui-monospace, monospace' }}>
                {def.icon}
              </span>
              {def.label}
            </Button>
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Tip: drag the handle to reorder · Ctrl/Cmd+Z to undo
          </span>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.lg }}>
        <Card title="Blocks">
          {sortedBlocks.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              Empty proposal. Add a block using the palette above.
            </p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext
                items={sortedBlocks.map((b) => b.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                  {sortedBlocks.map((b, i) => (
                    <SortableBlockRow
                      key={b.id}
                      block={b}
                      index={i}
                      def={REGISTRY.get(b.type)}
                      active={b.id === selectedId}
                      errors={errorsByBlockId.get(b.id) ?? []}
                      onSelect={() => setSelectedId(b.id)}
                      onChange={(patch) => setTree(updateBlock(tree, b.id, patch))}
                      onDuplicate={() => setTree(duplicateBlock(tree, b.id, generateId()))}
                      onDelete={() => {
                        if (selectedId === b.id) setSelectedId(null);
                        setTree(removeBlock(tree, b.id));
                      }}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </Card>

        <Card title="Preview">
          {sortedBlocks.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              Add blocks to see the preview.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {sortedBlocks.map((b) => {
                const def = REGISTRY.get(b.type);
                if (!def) {
                  return (
                    <div key={b.id} style={{ fontSize: 12, color: tokens.color.danger }}>
                      Unknown block type: {b.type}
                    </div>
                  );
                }
                return (
                  <div key={b.id}>
                    <def.Renderer block={b} />
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function SortableBlockRow({
  block,
  index,
  def,
  active,
  errors,
  onSelect,
  onChange,
  onDuplicate,
  onDelete,
}: {
  block: ProposalBlock;
  index: number;
  def: BlockTypeDef | undefined;
  active: boolean;
  errors: string[];
  onSelect: () => void;
  onChange: (patch: Partial<Omit<ProposalBlock, 'id'>>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}): JSX.Element {
  const sortable = useSortable({ id: block.id });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.6 : 1,
  } as const;
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        ...style,
        padding: tokens.space.sm,
        border: `1px solid ${
          errors.length > 0
            ? tokens.color.danger
            : active
              ? tokens.color.accent
              : tokens.color.border
        }`,
        borderRadius: tokens.radius.sm,
        background: active ? tokens.color.accentMuted : tokens.color.surface,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          marginBottom: active ? 8 : 0,
        }}
      >
        <button
          type="button"
          aria-label="Drag to reorder"
          {...sortable.attributes}
          {...sortable.listeners}
          style={{
            background: 'transparent',
            border: 0,
            color: tokens.color.textMuted,
            cursor: 'grab',
            fontSize: 16,
            padding: '0 4px',
            touchAction: 'none',
          }}
        >
          ⋮⋮
        </button>
        <button
          type="button"
          onClick={onSelect}
          style={{
            flex: 1,
            textAlign: 'left',
            background: 'transparent',
            border: 0,
            padding: 0,
            color: tokens.color.text,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          <span aria-hidden style={{ marginRight: 6, fontFamily: 'ui-monospace, monospace' }}>
            {def?.icon ?? '?'}
          </span>
          {def?.label ?? block.type}
          <span style={{ color: tokens.color.textMuted, marginLeft: 6 }}>#{index + 1}</span>
        </button>
        <Button size="sm" variant="ghost" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete}>
          Delete
        </Button>
      </div>
      {errors.length > 0 && (
        <div
          style={{
            marginTop: 4,
            padding: '4px 8px',
            background: tokens.color.surface,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            color: tokens.color.danger,
          }}
        >
          {errors.join(' · ')}
        </div>
      )}
      {active && def && <def.EditorFields block={block} onChange={onChange} />}
    </li>
  );
}
