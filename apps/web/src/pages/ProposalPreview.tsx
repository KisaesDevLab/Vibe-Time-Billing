// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff "preview as client" — a chrome-less, full-page render of a proposal's
// brochure using the same block renderers (mode="portal") the client sees.
// Opened in a popout window from the proposal editor. Read-only: no signing or
// acceptance actions (those live in the portal magic-link flow).

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { tokens } from '@vibe/ui';
import { isBlockTree, EMPTY_BLOCK_TREE, type ProposalBlockTree } from '@vibe/core/proposals';

import { api } from '../api-client';
import { REGISTRY } from '../proposal-editor/blocks';

interface ProposalRow {
  id: string;
  title: string;
  status: string;
  brochureJsonb: unknown;
}

export function ProposalPreviewPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const [proposal, setProposal] = useState<ProposalRow | null>(null);
  const [tree, setTree] = useState<ProposalBlockTree>(EMPTY_BLOCK_TREE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Proposal preview';
    void (async () => {
      try {
        const r = await api<{ proposal: ProposalRow }>(`/api/staff/proposals/${id}`);
        setProposal(r.proposal);
        setTree(
          isBlockTree(r.proposal.brochureJsonb) ? r.proposal.brochureJsonb : EMPTY_BLOCK_TREE,
        );
        if (r.proposal.title) document.title = `Preview — ${r.proposal.title}`;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'load_failed');
      }
    })();
  }, [id]);

  const blocks = [...tree.blocks].sort((a, b) => a.position - b.position);

  return (
    <div style={{ minHeight: '100vh', background: tokens.color.bg }}>
      {/* Preview banner — the one bit of non-client chrome, so staff know this
          is a preview. It does not appear in the real client view. */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: tokens.color.accentMuted,
          color: tokens.color.text,
          borderBottom: `1px solid ${tokens.color.border}`,
          padding: '8px 16px',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <strong>Client preview</strong>
        <span style={{ color: tokens.color.textMuted }}>
          This is how the proposal appears to the client. Signing &amp; payment actions are not
          shown here.
        </span>
        <button
          type="button"
          onClick={() => window.close()}
          style={{
            marginLeft: 'auto',
            border: `1px solid ${tokens.color.border}`,
            background: tokens.color.surface,
            color: tokens.color.text,
            borderRadius: tokens.radius.sm,
            padding: '2px 10px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Close
        </button>
      </div>

      <div style={{ maxWidth: 820, margin: '0 auto', padding: '24px 20px 64px' }}>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 14 }} role="alert">
            Could not load the proposal: {error}
          </p>
        )}
        {!error && !proposal && (
          <p style={{ color: tokens.color.textMuted, fontSize: 14 }}>Loading…</p>
        )}
        {proposal && blocks.length === 0 && (
          <p style={{ color: tokens.color.textMuted, fontSize: 14 }}>
            This proposal has no content blocks yet.
          </p>
        )}
        <div style={{ display: 'grid', gap: 16 }}>
          {blocks.map((b) => {
            const def = REGISTRY.get(b.type);
            if (!def) {
              return (
                <div key={b.id} style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  [unsupported block: {b.type}]
                </div>
              );
            }
            return (
              <div key={b.id}>
                <def.Renderer block={b} mode="portal" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
