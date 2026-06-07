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

import { Button, Card, Combobox, Input, Pill, SectionHeading, Table, tokens } from '@vibe/ui';
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
import { PALETTE_ORDER, REGISTRY, type BlockTypeDef } from '../proposal-editor/blocks';

interface ProposalDetail {
  proposal: {
    id: string;
    clientId: string;
    title: string;
    status: string;
    brochureJsonb: ProposalBlockTree | Record<string, unknown>;
    draftRevision: number;
    updatedAt: string;
    createEngagementOnAccept: boolean;
    requestTemplateIdOnAccept: string | null;
  };
}

interface RequestTemplateOption {
  id: string;
  name: string;
  status: string;
}

interface ClientContact {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
}

function generateId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Q34 — signer roster (staff editor draft state).
type SignerRole = 'PRIMARY' | 'COSIGNER' | 'WITNESS';
interface SignerDraft {
  key: string;
  name: string;
  email: string;
  phone: string;
  role: SignerRole;
  required: boolean;
}
interface SignerStatusRow {
  id: string;
  signerName: string;
  signerEmail: string;
  role: string;
  required: boolean;
  sequence: number;
  state: 'PENDING' | 'SIGNED' | 'DECLINED';
}

const labelStyle = {
  display: 'block',
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
} as const;

function newSigner(role: SignerRole): SignerDraft {
  return { key: generateId(), name: '', email: '', phone: '', role, required: true };
}

function validateSigners(signers: SignerDraft[]): string | null {
  if (signers.length === 0) return null; // no roster → legacy single-signer
  const emails: string[] = [];
  for (const s of signers) {
    if (!s.name.trim()) return 'Every signer needs a name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email.trim()))
      return `Invalid email: ${s.email || '(blank)'}`;
    emails.push(s.email.trim().toLowerCase());
  }
  if (new Set(emails).size !== emails.length) return 'Signer emails must be unique.';
  if (!signers.some((s) => s.required)) return 'At least one signer must be required.';
  return null;
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
  const [sending, setSending] = useState(false);
  const [versions, setVersions] = useState<
    { id: string; version: number; contentHash: string; reason: string; createdAt: string }[]
  >([]);
  // Q34 — signer roster draft (pre-send) + post-send status.
  const [signers, setSigners] = useState<SignerDraft[]>([]);
  const [signingOrderMode, setSigningOrderMode] = useState<'PARALLEL' | 'SEQUENTIAL'>('PARALLEL');
  const [signerStatus, setSignerStatus] = useState<SignerStatusRow[]>([]);
  const [signerMsg, setSignerMsg] = useState<string | null>(null);
  const [contacts, setContacts] = useState<ClientContact[]>([]);
  // On-acceptance actions.
  const [createEng, setCreateEng] = useState(true);
  const [reqTemplateId, setReqTemplateId] = useState<string>('');
  const [reqTemplates, setReqTemplates] = useState<RequestTemplateOption[]>([]);

  async function load(): Promise<void> {
    try {
      const r = await api<ProposalDetail>(`/api/staff/proposals/${id}`);
      setDetail(r.proposal);
      setCreateEng(r.proposal.createEngagementOnAccept !== false);
      setReqTemplateId(r.proposal.requestTemplateIdOnAccept ?? '');
      const tree = coerceTree(r.proposal.brochureJsonb);
      undo.reset(tree);
      setBaseline(tree);
      setLoadErr(null);
      // Load the proposal's client contacts so signers can be pulled in.
      if (r.proposal.clientId) {
        void api<{ items: ClientContact[] }>(`/api/staff/clients/${r.proposal.clientId}/contacts`)
          .then((c) => setContacts(c.items ?? []))
          .catch(() => setContacts([]));
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'load_failed');
    }
  }

  // Request-list templates for the "On acceptance" picker (best-effort).
  useEffect(() => {
    void api<{ items: RequestTemplateOption[] }>('/api/staff/admin/templates/request')
      .then((r) => setReqTemplates((r.items ?? []).filter((t) => t.status === 'ACTIVE')))
      .catch(() => setReqTemplates([]));
  }, []);

  async function saveAcceptance(next: {
    createEngagementOnAccept?: boolean;
    requestTemplateIdOnAccept?: string | null;
  }): Promise<void> {
    try {
      await api(`/api/staff/proposals/${id}`, { method: 'PATCH', body: JSON.stringify(next) });
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'save_failed');
    }
  }

  async function loadVersions(): Promise<void> {
    try {
      const r = await api<{
        items: {
          id: string;
          version: number;
          contentHash: string;
          reason: string;
          createdAt: string;
        }[];
      }>(`/api/staff/proposals/${id}/versions`);
      setVersions(r.items ?? []);
    } catch {
      // Versions table is best-effort UI; failure shouldn't block the editor.
    }
  }

  async function loadSignerStatus(): Promise<void> {
    try {
      const r = await api<{ signers: SignerStatusRow[]; signingOrderMode: string }>(
        `/api/staff/proposals/${id}/signers`,
      );
      setSignerStatus(r.signers ?? []);
      if (r.signingOrderMode === 'SEQUENTIAL' || r.signingOrderMode === 'PARALLEL') {
        setSigningOrderMode(r.signingOrderMode);
      }
    } catch {
      // best-effort UI; failure shouldn't block the editor.
    }
  }

  useEffect(() => {
    void load();
    void loadVersions();
    void loadSignerStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function send(): Promise<void> {
    const validationErr = validateSigners(signers);
    if (validationErr) {
      setSignerMsg(validationErr);
      return;
    }
    setSending(true);
    setLoadErr(null);
    setSignerMsg(null);
    try {
      await autosave.flush();
      const body: Record<string, unknown> = {};
      if (signers.length > 0) {
        body['signingOrderMode'] = signingOrderMode;
        body['signers'] = signers.map((s) => ({
          name: s.name.trim(),
          email: s.email.trim(),
          phone: s.phone.trim() || null,
          role: s.role,
          required: s.required,
        }));
      }
      await api(`/api/staff/proposals/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Mint + email each signer's link (multi-signer only).
      if (signers.length > 0) {
        await api(`/api/staff/proposals/${id}/mint-all-magic-links`, {
          method: 'POST',
          body: '{}',
        });
      }
      await load();
      await loadVersions();
      await loadSignerStatus();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'send_failed');
    } finally {
      setSending(false);
    }
  }

  async function resendSigner(row: SignerStatusRow): Promise<void> {
    setSignerMsg(null);
    try {
      await api(`/api/staff/proposals/${id}/mint-magic-link`, {
        method: 'POST',
        body: JSON.stringify({ signatureId: row.id }),
      });
      setSignerMsg(`Resent link to ${row.signerEmail}.`);
    } catch (e) {
      setSignerMsg(e instanceof Error ? e.message : 'resend_failed');
    }
  }

  async function replaceSigner(row: SignerStatusRow): Promise<void> {
    const email = window.prompt(`Replace signer ${row.signerName} — new email:`, row.signerEmail);
    if (!email) return;
    const name = window.prompt('New signer name:', row.signerName);
    if (!name) return;
    setSignerMsg(null);
    try {
      await api(`/api/staff/proposals/${id}/signers/${row.id}/replace`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      await loadSignerStatus();
      setSignerMsg(`Re-invited ${email.trim()}.`);
    } catch (e) {
      setSignerMsg(e instanceof Error ? e.message : 'replace_failed');
    }
  }

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
            <Button
              size="sm"
              variant="secondary"
              title="Open a client's-eye preview in a new window"
              onClick={() => {
                // Flush any pending edits first so the preview reflects the
                // latest blocks, then pop out the chrome-less preview route.
                void autosave.flush();
                window.open(
                  `/proposals/${id}/preview`,
                  `proposal-preview-${id}`,
                  'width=900,height=1100,scrollbars=yes,resizable=yes',
                );
              }}
            >
              Preview as client
            </Button>
            {detail.status === 'DRAFT' && (
              <Button
                size="sm"
                disabled={errors.length > 0 || sending}
                onClick={() => void send()}
                title={
                  errors.length > 0
                    ? 'Resolve validation issues before sending'
                    : 'Snapshot the proposal as v1 and mark it SENT'
                }
              >
                {sending ? 'Sending…' : 'Send proposal'}
              </Button>
            )}
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
          {PALETTE_ORDER.map((def) => (
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

      {detail.status === 'DRAFT' && (
        <Card title="On acceptance">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            What happens automatically when the client accepts &amp; signs.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={createEng}
              onChange={(e) => {
                const v = e.target.checked;
                setCreateEng(v);
                if (!v) {
                  setReqTemplateId('');
                  void saveAcceptance({
                    createEngagementOnAccept: false,
                    requestTemplateIdOnAccept: null,
                  });
                } else {
                  void saveAcceptance({ createEngagementOnAccept: true });
                }
              }}
            />
            Create an engagement when the client accepts
          </label>
          <div style={{ marginTop: 12, maxWidth: 380 }}>
            <span style={labelStyle}>Send a request list on acceptance</span>
            <Combobox
              ariaLabel="Request list template"
              clearable
              disabled={!createEng}
              value={reqTemplateId}
              onChange={(v) => {
                const next = v || '';
                setReqTemplateId(next);
                void saveAcceptance({ requestTemplateIdOnAccept: next || null });
              }}
              options={reqTemplates.map((t) => ({ value: t.id, label: t.name }))}
              placeholder={reqTemplates.length === 0 ? 'No request templates yet' : 'None'}
            />
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
              {createEng
                ? 'The list is created on the new engagement when the client accepts.'
                : 'Requires "Create an engagement" — a request list must attach to an engagement.'}
            </div>
          </div>
        </Card>
      )}

      <Card title="Signers">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          {detail.status === 'DRAFT'
            ? 'Add one row per signer for a multi-signer proposal. Leave empty for the default single-signer flow.'
            : 'Signing roster for this proposal.'}
        </p>

        {detail.status === 'DRAFT' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ width: 220 }}>
              <span style={labelStyle}>Signing order</span>
              <Combobox
                ariaLabel="Signing order"
                value={signingOrderMode}
                onChange={(v) =>
                  setSigningOrderMode((v as 'PARALLEL' | 'SEQUENTIAL') ?? 'PARALLEL')
                }
                options={[
                  { value: 'PARALLEL', label: 'Parallel (any order)' },
                  { value: 'SEQUENTIAL', label: 'Sequential (one at a time)' },
                ]}
              />
            </div>

            {signers.map((s, i) => (
              <div
                key={s.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.5fr 2fr 1.2fr 1.3fr auto auto',
                  gap: 8,
                  alignItems: 'end',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  padding: 8,
                }}
              >
                <div>
                  <span style={labelStyle}>Name</span>
                  <Input
                    aria-label={`Signer ${i + 1} name`}
                    value={s.name}
                    onChange={(e) =>
                      setSigners((prev) =>
                        prev.map((x) => (x.key === s.key ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div>
                  <span style={labelStyle}>Email</span>
                  <Input
                    aria-label={`Signer ${i + 1} email`}
                    type="email"
                    value={s.email}
                    onChange={(e) =>
                      setSigners((prev) =>
                        prev.map((x) => (x.key === s.key ? { ...x, email: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div>
                  <span style={labelStyle}>Phone</span>
                  <Input
                    aria-label={`Signer ${i + 1} phone`}
                    value={s.phone}
                    onChange={(e) =>
                      setSigners((prev) =>
                        prev.map((x) => (x.key === s.key ? { ...x, phone: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div>
                  <span style={labelStyle}>Role</span>
                  <Combobox
                    ariaLabel={`Signer ${i + 1} role`}
                    value={s.role}
                    onChange={(v) =>
                      setSigners((prev) =>
                        prev.map((x) =>
                          x.key === s.key ? { ...x, role: (v as SignerRole) ?? 'COSIGNER' } : x,
                        ),
                      )
                    }
                    options={[
                      { value: 'PRIMARY', label: 'Primary' },
                      { value: 'COSIGNER', label: 'Co-signer' },
                      { value: 'WITNESS', label: 'Witness' },
                    ]}
                  />
                </div>
                <div>
                  <span style={labelStyle}>Required</span>
                  <input
                    type="checkbox"
                    aria-label={`Signer ${i + 1} required`}
                    checked={s.required}
                    onChange={(e) =>
                      setSigners((prev) =>
                        prev.map((x) =>
                          x.key === s.key ? { ...x, required: e.target.checked } : x,
                        ),
                      )
                    }
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSigners((prev) => prev.filter((x) => x.key !== s.key))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setSigners((prev) => [
                    ...prev,
                    newSigner(prev.length === 0 ? 'PRIMARY' : 'COSIGNER'),
                  ])
                }
              >
                + Add signer
              </Button>
              {contacts.length > 0 && (
                <div style={{ minWidth: 280 }}>
                  <Combobox
                    ariaLabel="Add signer from client contact"
                    placeholder="+ Add from client contacts…"
                    clearable
                    value=""
                    onChange={(contactId) => {
                      if (!contactId) return;
                      const c = contacts.find((x) => x.id === contactId);
                      if (!c) return;
                      setSigners((prev) => {
                        // Skip if this contact's email is already a signer.
                        if (
                          c.email &&
                          prev.some((s) => s.email.toLowerCase() === c.email!.toLowerCase())
                        ) {
                          return prev;
                        }
                        return [
                          ...prev,
                          {
                            key: generateId(),
                            name: c.fullName,
                            email: c.email ?? '',
                            phone: c.mobile ?? c.phone ?? '',
                            role: prev.length === 0 ? 'PRIMARY' : 'COSIGNER',
                            required: true,
                          },
                        ];
                      });
                    }}
                    options={contacts.map((c) => ({
                      value: c.id,
                      label: `${c.fullName}${c.isPrimary ? ' (primary)' : ''}${
                        c.email ? ` · ${c.email}` : ' · no email'
                      }`,
                    }))}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {signerStatus.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>
              {signerStatus.filter((s) => s.state === 'SIGNED').length} of{' '}
              {signerStatus.filter((s) => s.required).length} signed
            </p>
            <Table<SignerStatusRow>
              columns={[
                { key: 'name', header: 'Signer', render: (r) => r.signerName },
                { key: 'email', header: 'Email', render: (r) => r.signerEmail },
                { key: 'role', header: 'Role', render: (r) => <Pill>{r.role}</Pill> },
                {
                  key: 'state',
                  header: 'State',
                  render: (r) => (
                    <Pill
                      tone={
                        r.state === 'SIGNED'
                          ? 'success'
                          : r.state === 'DECLINED'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {r.state}
                    </Pill>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  render: (r) =>
                    r.state === 'SIGNED' ? (
                      <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>—</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Button size="sm" variant="ghost" onClick={() => void resendSigner(r)}>
                          Resend
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void replaceSigner(r)}>
                          Replace
                        </Button>
                      </div>
                    ),
                },
              ]}
              rows={signerStatus}
              rowKey={(r) => r.id}
            />
          </div>
        )}

        {signerMsg && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 8 }}>{signerMsg}</p>
        )}
      </Card>

      {versions.length > 0 && (
        <Card title="Versions">
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            {versions.map((v) => (
              <li
                key={v.id}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'baseline',
                  fontSize: 13,
                  padding: '6px 8px',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                }}
              >
                <strong>v{v.version}</strong>
                <Pill>{v.reason}</Pill>
                <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>
                  {new Date(v.createdAt).toLocaleString()}
                </span>
                <code
                  style={{
                    color: tokens.color.textMuted,
                    fontSize: 11,
                    marginLeft: 'auto',
                  }}
                  title={v.contentHash}
                >
                  {v.contentHash.slice(0, 12)}…
                </code>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
            Each row is an immutable snapshot. The content hash never changes — what the client saw
            at send-time hashes to this value forever.
          </p>
        </Card>
      )}
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
