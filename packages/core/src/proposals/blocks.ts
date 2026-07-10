// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P04 — Proposal block-tree schema + validation.
//
// Defines the canonical block tree that lives in
// proposals.brochure_jsonb. The visual editor produces this shape;
// the proposal versioning layer (P06) snapshots it; the portal
// renderer (P20) walks it; the block-type implementations (P05) live
// alongside the editor in apps/web/src/proposal-editor.
//
// The registry pattern (Editor / Renderer React components) lives in
// the web app since it pulls React. This module is the pure-data side:
// schema, validation, normalization, helpers — usable by the API,
// worker, and tests without dragging React in.

export interface ProposalBlock {
  id: string;
  type: string;
  position: number;
  // Free-form per-block props. Each block type defines its own shape;
  // validation is delegated to the registry.
  props: Record<string, unknown>;
  // Visibility gating — empty roles array means "visible to everyone."
  // Future enhancement (v1.5+): per-block role-scoped reveal.
  visibility?: { roles?: string[] };
}

export interface ProposalBlockTree {
  blocks: ProposalBlock[];
  // Schema version of the tree itself. Increments only on breaking
  // shape changes; props validation is per-block-type.
  schemaVersion: 1;
}

export const EMPTY_BLOCK_TREE: ProposalBlockTree = {
  blocks: [],
  schemaVersion: 1,
};

export function isBlockTree(value: unknown): value is ProposalBlockTree {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ProposalBlockTree>;
  return v.schemaVersion === 1 && Array.isArray(v.blocks) && v.blocks.every((b) => isBlock(b));
}

export function isBlock(value: unknown): value is ProposalBlock {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<ProposalBlock>;
  return (
    typeof b.id === 'string' &&
    b.id.length > 0 &&
    typeof b.type === 'string' &&
    b.type.length > 0 &&
    typeof b.position === 'number' &&
    Number.isFinite(b.position) &&
    !!b.props &&
    typeof b.props === 'object' &&
    !Array.isArray(b.props)
  );
}

// =====================================================================
// Tree manipulation helpers (pure functions — UI uses them directly)
// =====================================================================

export function addBlock(tree: ProposalBlockTree, block: ProposalBlock): ProposalBlockTree {
  return {
    ...tree,
    blocks: normalizePositions([...tree.blocks, block]),
  };
}

export function removeBlock(tree: ProposalBlockTree, id: string): ProposalBlockTree {
  return {
    ...tree,
    blocks: normalizePositions(tree.blocks.filter((b) => b.id !== id)),
  };
}

export function updateBlock(
  tree: ProposalBlockTree,
  id: string,
  patch: Partial<Omit<ProposalBlock, 'id'>>,
): ProposalBlockTree {
  return {
    ...tree,
    blocks: tree.blocks.map((b) => (b.id === id ? { ...b, ...patch, id: b.id } : b)),
  };
}

export function moveBlock(
  tree: ProposalBlockTree,
  id: string,
  direction: 'up' | 'down',
): ProposalBlockTree {
  const sorted = [...tree.blocks].sort((a, b) => a.position - b.position);
  const idx = sorted.findIndex((b) => b.id === id);
  if (idx === -1) return tree;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= sorted.length) return tree;
  const next = [...sorted];
  const tmp = next[idx]!;
  next[idx] = next[swapIdx]!;
  next[swapIdx] = tmp;
  return { ...tree, blocks: normalizePositions(next) };
}

export function reorderBlocks(
  tree: ProposalBlockTree,
  fromIndex: number,
  toIndex: number,
): ProposalBlockTree {
  const sorted = [...tree.blocks].sort((a, b) => a.position - b.position);
  if (fromIndex < 0 || fromIndex >= sorted.length) return tree;
  if (toIndex < 0 || toIndex >= sorted.length) return tree;
  const [moved] = sorted.splice(fromIndex, 1);
  if (!moved) return tree;
  sorted.splice(toIndex, 0, moved);
  return { ...tree, blocks: normalizePositions(sorted) };
}

export function duplicateBlock(
  tree: ProposalBlockTree,
  id: string,
  newId: string,
): ProposalBlockTree {
  const target = tree.blocks.find((b) => b.id === id);
  if (!target) return tree;
  const sorted = [...tree.blocks].sort((a, b) => a.position - b.position);
  const idx = sorted.findIndex((b) => b.id === id);
  const dupe: ProposalBlock = {
    ...target,
    id: newId,
    props: structuredCloneCompat(target.props),
  };
  sorted.splice(idx + 1, 0, dupe);
  return { ...tree, blocks: normalizePositions(sorted) };
}

// Re-sequence positions to 0..n-1 in current array order. Keeps the
// tree compact and stable for diffing.
function normalizePositions(blocks: ProposalBlock[]): ProposalBlock[] {
  return blocks.map((b, i) => ({ ...b, position: i })).sort((a, b) => a.position - b.position);
}

function structuredCloneCompat(value: unknown): Record<string, unknown> {
  // structuredClone is available in Node 17+ and modern browsers; the
  // shim path keeps us safe in any older runtimes a future caller may
  // bring.
  if (typeof structuredClone === 'function') {
    return structuredClone(value) as Record<string, unknown>;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

// =====================================================================
// Block-type validation interface (the registry consumers implement)
// =====================================================================

export interface BlockTypeValidator {
  type: string;
  // Throw with a stable error code on invalid props; the editor
  // surfaces these to the user.
  validate(props: Record<string, unknown>): void;
}

export class BlockValidationError extends Error {
  readonly blockId: string;
  readonly blockType: string;
  readonly code: string;
  constructor(blockId: string, blockType: string, code: string, message: string) {
    super(message);
    this.blockId = blockId;
    this.blockType = blockType;
    this.code = code;
  }
}

export function validateTree(
  tree: ProposalBlockTree,
  validators: Map<string, BlockTypeValidator>,
): BlockValidationError[] {
  const errors: BlockValidationError[] = [];
  for (const block of tree.blocks) {
    const v = validators.get(block.type);
    if (!v) {
      errors.push(
        new BlockValidationError(
          block.id,
          block.type,
          'unknown_type',
          `Unknown block type: ${block.type}`,
        ),
      );
      continue;
    }
    try {
      v.validate(block.props);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = e instanceof BlockValidationError ? e.code : 'invalid_props';
      errors.push(new BlockValidationError(block.id, block.type, code, message));
    }
  }
  return errors;
}
