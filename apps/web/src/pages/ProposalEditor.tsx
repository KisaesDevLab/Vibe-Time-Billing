// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4a — Proposal editor (no dnd yet).
//
// Two columns:
//   Left:  block list with up/down/duplicate/delete + inline editor
//          for the selected block. Add-block palette at top.
//   Right: live preview of the rendered tree.
//
// PP4b will:
//   • swap up/down for drag-drop via dnd-kit
//   • add 2s debounced autosave (current behavior is explicit Save
//     button + dirty indicator)
//   • run block-type validation on every change and surface errors
//   • undo/redo
//
// Block types in PP4a: text, heading, divider. P05 adds the rest
// (services, package selector, terms, signature, video, cover).

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, Card, Input, Pill, SectionHeading, tokens } from '@vibe/ui';

import {
  addBlock,
  duplicateBlock,
  EMPTY_BLOCK_TREE,
  isBlockTree,
  moveBlock,
  removeBlock,
  updateBlock,
  type ProposalBlock,
  type ProposalBlockTree,
} from '@vibe/core/proposals';

import { api } from '../api-client';

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

// Block-type registry — local to PP4a. PP4b will move this into a
// shared module so portal-side rendering can reuse it.
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

export function ProposalEditorPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const [detail, setDetail] = useState<ProposalDetail['proposal'] | null>(null);
  const [tree, setTree] = useState<ProposalBlockTree>(EMPTY_BLOCK_TREE);
  const [savedRevision, setSavedRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    const r = await api<ProposalDetail>(`/api/staff/proposals/${id}`);
    setDetail(r.proposal);
    setTree(coerceTree(r.proposal.brochureJsonb));
    setSavedRevision(r.proposal.draftRevision);
  }

  useEffect(() => {
    void load().catch((e) => setErr(e instanceof Error ? e.message : 'load_failed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dirty = useMemo(() => {
    if (!detail) return false;
    const orig = JSON.stringify(coerceTree(detail.brochureJsonb));
    return JSON.stringify(tree) !== orig;
  }, [detail, tree]);

  async function save(): Promise<void> {
    if (!detail || !dirty) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ draftRevision: number }>(`/api/staff/proposals/${id}/brochure`, {
        method: 'POST',
        body: JSON.stringify({ brochureJsonb: tree }),
      });
      setSavedRevision(r.draftRevision);
      // Refresh detail so dirty diff resets correctly.
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

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

  if (!detail) {
    return (
      <div style={{ padding: tokens.space.lg }}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>{err ?? 'Loading proposal…'}</p>
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
            · Status <Pill>{detail.status}</Pill> · Saved revision v{savedRevision}
            {dirty && (
              <>
                {' '}
                · <Pill tone="warning">Unsaved changes</Pill>
              </>
            )}
          </span>
        }
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty}
              onClick={() => {
                if (detail) setTree(coerceTree(detail.brochureJsonb));
              }}
            >
              Revert
            </Button>
            <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        }
      />
      {err && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>}

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
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.lg }}>
        <Card title="Blocks">
          {sortedBlocks.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              Empty proposal. Add a block using the palette above.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
              {sortedBlocks.map((b, i) => {
                const def = REGISTRY.get(b.type);
                const active = b.id === selectedId;
                return (
                  <li
                    key={b.id}
                    style={{
                      padding: tokens.space.sm,
                      border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
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
                        onClick={() => setSelectedId(b.id)}
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
                        <span
                          aria-hidden
                          style={{ marginRight: 6, fontFamily: 'ui-monospace, monospace' }}
                        >
                          {def?.icon ?? '?'}
                        </span>
                        {def?.label ?? b.type}
                        <span style={{ color: tokens.color.textMuted, marginLeft: 6 }}>
                          #{i + 1}
                        </span>
                      </button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setTree(moveBlock(tree, b.id, 'up'))}
                        disabled={i === 0}
                        aria-label="Move up"
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setTree(moveBlock(tree, b.id, 'down'))}
                        disabled={i === sortedBlocks.length - 1}
                        aria-label="Move down"
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setTree(duplicateBlock(tree, b.id, generateId()))}
                      >
                        Duplicate
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (selectedId === b.id) setSelectedId(null);
                          setTree(removeBlock(tree, b.id));
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                    {active && def && (
                      <def.EditorFields
                        block={b}
                        onChange={(patch) => setTree(updateBlock(tree, b.id, patch))}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
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
