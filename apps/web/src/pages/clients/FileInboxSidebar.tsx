// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Inbox sidebar: per-client list of un-filed files (is_inbox=true).
// Drag onto a folder in the FolderTree to file the file.

import { tokens } from '@vibe/ui';

interface InboxFile {
  id: string;
  fileName: string;
  uploadedAt: string;
}

interface Props {
  files: InboxFile[];
  onOpenFile?: (id: string) => void;
}

export function FileInboxSidebar({ files, onOpenFile }: Props): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: tokens.color.textMuted,
          padding: '0 4px',
        }}
      >
        Inbox · {files.length}
      </div>
      {files.length === 0 && (
        <div
          style={{
            fontSize: 12,
            color: tokens.color.textMuted,
            padding: '8px 6px',
            border: `1px dashed ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
          }}
        >
          Inbox is empty. New uploads without a folder pick land here.
        </div>
      )}
      {files.map((f) => (
        <div
          key={f.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/x-vibe-file', f.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onClick={() => onOpenFile?.(f.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenFile?.(f.id);
            }
          }}
          tabIndex={0}
          role="button"
          aria-label={`Inbox file ${f.fileName} — drag onto a folder to file`}
          style={{
            padding: '6px 8px',
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            background: tokens.color.bg,
            fontSize: 12,
            cursor: 'grab',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span aria-hidden="true">📄</span>
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {f.fileName}
          </span>
        </div>
      ))}
    </div>
  );
}
