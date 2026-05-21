// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Recursive folder tree for the file manager left rail. Renders a flat
// list of folder rows from the API and assembles a tree by parent_id.

import { useMemo, useState } from 'react';

import { tokens } from '@vibe/ui';

export interface Folder {
  id: string;
  name: string;
  parentFolderId: string | null;
}

interface Props {
  folders: Folder[];
  selectedFolderId: string | null | 'root' | 'inbox';
  onSelectFolder: (id: string | null | 'root' | 'inbox') => void;
  inboxCount?: number;
  totalCount?: number;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
  onDropFile?: (fileId: string, folderId: string | null) => void;
  scope: 'client' | 'internal';
}

interface TreeNode extends Folder {
  children: TreeNode[];
}

function buildTree(folders: Folder[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const f of folders) byId.set(f.id, { ...f, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentFolderId && byId.has(node.parentFolderId)) {
      byId.get(node.parentFolderId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (list: TreeNode[]): void => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

export function FolderTree({
  folders,
  selectedFolderId,
  onSelectFolder,
  inboxCount,
  totalCount,
  onRename,
  onDelete,
  onDropFile,
  scope,
}: Props): JSX.Element {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleDrop(e: React.DragEvent, folderId: string | null): void {
    e.preventDefault();
    e.stopPropagation();
    const fileId = e.dataTransfer.getData('text/x-vibe-file');
    if (fileId && onDropFile) onDropFile(fileId, folderId);
  }

  const renderNode = (node: TreeNode, depth: number): JSX.Element => {
    const isOpen = expanded.has(node.id);
    const isSelected = selectedFolderId === node.id;
    const hasChildren = node.children.length > 0;
    return (
      <div key={node.id}>
        <div
          role="treeitem"
          aria-expanded={hasChildren ? isOpen : undefined}
          aria-selected={isSelected}
          onClick={() => onSelectFolder(node.id)}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => handleDrop(e, node.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelectFolder(node.id);
            }
            if (e.key === 'F2' && onRename) {
              e.preventDefault();
              const n = prompt('Rename folder', node.name);
              if (n && n.trim() && n !== node.name) onRename(node.id, n.trim());
            }
            if (e.key === 'Delete' && onDelete) {
              e.preventDefault();
              if (confirm(`Delete folder "${node.name}"?`)) onDelete(node.id);
            }
          }}
          tabIndex={0}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: `4px 6px`,
            paddingLeft: 6 + depth * 14,
            borderRadius: tokens.radius.sm,
            cursor: 'pointer',
            background: isSelected ? tokens.color.surface : 'transparent',
            color: isSelected ? tokens.color.text : tokens.color.text,
            fontSize: 13,
          }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.id);
              }}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: tokens.color.textMuted,
                fontSize: 10,
                width: 14,
                textAlign: 'center',
                padding: 0,
              }}
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span style={{ width: 14 }} />
          )}
          <span aria-hidden="true">📁</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
        </div>
        {isOpen && hasChildren && (
          <div role="group">{node.children.map((c) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div
      role="tree"
      aria-label={scope === 'internal' ? 'Internal folders' : 'Client folders'}
      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <div
        role="treeitem"
        aria-selected={selectedFolderId === 'root' || selectedFolderId === null}
        onClick={() => onSelectFolder('root')}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => handleDrop(e, null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectFolder('root');
          }
        }}
        tabIndex={0}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: 6,
          borderRadius: tokens.radius.sm,
          cursor: 'pointer',
          background:
            selectedFolderId === 'root' || selectedFolderId === null
              ? tokens.color.surface
              : 'transparent',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <span aria-hidden="true">📂</span>
        <span style={{ flex: 1 }}>All files</span>
        {totalCount !== undefined && (
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{totalCount}</span>
        )}
      </div>
      {scope === 'client' && (
        <div
          role="treeitem"
          aria-selected={selectedFolderId === 'inbox'}
          onClick={() => onSelectFolder('inbox')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelectFolder('inbox');
            }
          }}
          tabIndex={0}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: 6,
            borderRadius: tokens.radius.sm,
            cursor: 'pointer',
            background: selectedFolderId === 'inbox' ? tokens.color.surface : 'transparent',
            fontSize: 13,
          }}
        >
          <span aria-hidden="true">📥</span>
          <span style={{ flex: 1 }}>File inbox</span>
          {inboxCount !== undefined && inboxCount > 0 && (
            <span
              style={{
                fontSize: 11,
                padding: '1px 6px',
                background: tokens.color.accent,
                color: '#fff',
                borderRadius: 999,
              }}
            >
              {inboxCount}
            </span>
          )}
        </div>
      )}
      <div style={{ marginTop: 4 }}>{tree.map((node) => renderNode(node, 0))}</div>
    </div>
  );
}
