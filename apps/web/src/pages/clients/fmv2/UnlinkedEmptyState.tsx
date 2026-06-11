// SPDX-License-Identifier: Elastic-2.0
//
// FMv2 mockup 1 — empty state when a client has no client_folders row.

import { useState } from 'react';

import { Card, tokens } from '@vibe/ui';

import { CreateFolderDialog } from './CreateFolderDialog';
import { LinkFolderModal } from './LinkFolderModal';

interface Props {
  clientId: string;
  clientName: string;
  taxSoftwareId?: string | null;
  canBind: boolean;
  canEdit: boolean;
  canReconcile: boolean;
  /** Called when the link or create completes — Files tab should
   *  transition into the indexing substate. */
  onLinked: (clientFolderId: string, storagePath: string) => void;
}

export function UnlinkedEmptyState({
  clientId,
  clientName,
  taxSoftwareId,
  canBind,
  canEdit,
  canReconcile,
  onLinked,
}: Props): JSX.Element {
  const [showLink, setShowLink] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <Card title="Files">
      <div
        style={{
          padding: '24px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 12,
        }}
      >
        <div
          aria-hidden
          style={{
            fontSize: 32,
            color: tokens.color.textMuted,
            lineHeight: 1,
          }}
        >
          📁
        </div>
        <h2 style={{ fontSize: 18, margin: 0 }}>No storage folder yet</h2>
        <p
          style={{
            fontSize: 13,
            color: tokens.color.textMuted,
            margin: 0,
            maxWidth: 440,
          }}
        >
          Link <strong>{clientName}</strong> to an existing folder in your firm bucket — or create a
          fresh one.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={() => setShowLink(true)}
            disabled={!canBind}
            title={!canBind ? 'Requires storage:folder:bind' : undefined}
            style={{
              padding: '8px 16px',
              background: canBind ? tokens.color.accent : tokens.color.border,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radius.sm,
              cursor: canBind ? 'pointer' : 'not-allowed',
              fontSize: 14,
            }}
          >
            Link folder…
          </button>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            disabled={!canBind || !canEdit}
            title={!canBind || !canEdit ? 'Requires storage:folder:bind + edit' : undefined}
            style={{
              padding: '8px 16px',
              background: 'transparent',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              cursor: canBind && canEdit ? 'pointer' : 'not-allowed',
              fontSize: 14,
            }}
          >
            Create new folder
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            marginTop: 20,
            maxWidth: 560,
            width: '100%',
          }}
        >
          <FeatureCard
            title="Fuzzy match"
            body="Finds the right folder by name, tax ID, or alias even when the typing is off."
          />
          <FeatureCard
            title="Conflict-safe"
            body="If the folder is already bound to another client, an admin reviews before re-assignment."
          />
          <FeatureCard
            title="Live indexing"
            body="After linking, files appear in the table as the sync worker discovers them."
          />
        </div>

        <a
          href="/docs/storage-linking"
          style={{ fontSize: 12, color: tokens.color.accent, marginTop: 4 }}
        >
          How storage linking works
        </a>
      </div>

      {showLink && (
        <LinkFolderModal
          clientId={clientId}
          clientName={clientName}
          taxSoftwareId={taxSoftwareId}
          canReconcile={canReconcile}
          onClose={() => setShowLink(false)}
          onLinked={(id, path) => {
            setShowLink(false);
            onLinked(id, path);
          }}
        />
      )}
      {showCreate && (
        <CreateFolderDialog
          clientId={clientId}
          defaultName={clientName}
          onClose={() => setShowCreate(false)}
          onCreated={(id, path) => {
            setShowCreate(false);
            onLinked(id, path);
          }}
        />
      )}
    </Card>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div
      style={{
        padding: 12,
        background: tokens.color.bg,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        textAlign: 'left',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted, lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}
