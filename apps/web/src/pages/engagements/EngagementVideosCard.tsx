/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers (same posture as DropOffCard) */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Engagement "Videos" card (0235). Staff upload a video the client
// watches in the portal, see whether it was played (and how far), extend
// or shorten the two retention clocks, open the per-viewer play log, and
// delete early. Expired and deleted videos stay listed for history.

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';

import { Button, Card, Menu, Modal, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';
import { formatAvailableUntil, formatBytes, videoStatusPill } from '../../lib/video-upload';
import {
  RetentionField,
  VideoUploadDialog,
  type VideoRetentionDefaults,
} from './VideoUploadDialog';
import { VideoPlaysModal } from './VideoPlaysModal';

export interface StaffVideoRow {
  id: string;
  engagementId: string;
  engagementName?: string;
  clientId: string;
  title: string;
  message: string | null;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: 'PENDING_UPLOAD' | 'AVAILABLE' | 'EXPIRED' | 'DELETED';
  uploadedAt: string;
  deleteAfterDays: number | null;
  deleteDaysAfterFirstPlay: number | null;
  expiresAt: string | null;
  notifyClient: boolean;
  notifiedAt: string | null;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  playCount: number;
  maxProgressPct: number | null;
  replyCount: number;
}

function inputStyle(): CSSProperties {
  return {
    padding: '6px 8px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.surface,
    color: tokens.color.text,
  };
}

async function loadRetentionDefaults(): Promise<VideoRetentionDefaults> {
  try {
    const r = await api<{
      settings?: {
        videoDefaultDeleteAfterDays?: number | null;
        videoDefaultDeleteDaysAfterPlay?: number | null;
      };
    }>('/api/staff/admin/firm-settings');
    return {
      deleteAfterDays: r.settings?.videoDefaultDeleteAfterDays ?? 30,
      deleteDaysAfterFirstPlay: r.settings?.videoDefaultDeleteDaysAfterPlay ?? 3,
    };
  } catch {
    return { deleteAfterDays: 30, deleteDaysAfterFirstPlay: 3 };
  }
}

function VideoEditDialog({
  video,
  onClose,
  onSaved,
}: {
  video: StaffVideoRow;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(video.title);
  const [message, setMessage] = useState(video.message ?? '');
  const [deleteAfterDays, setDeleteAfterDays] = useState<number | null>(video.deleteAfterDays);
  const [deleteDaysAfterFirstPlay, setDeleteDaysAfterFirstPlay] = useState<number | null>(
    video.deleteDaysAfterFirstPlay,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/videos/${video.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim(),
          message: message.trim() ? message.trim() : null,
          deleteAfterDays,
          deleteDaysAfterFirstPlay,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit video" onClose={busy ? undefined : onClose} maxWidth={520}>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            style={inputStyle()}
            required
          />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            maxLength={2000}
            style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
        <RetentionField
          label="Delete after upload"
          hint={`Uploaded ${new Date(video.uploadedAt).toLocaleDateString()}.`}
          value={deleteAfterDays}
          onChange={setDeleteAfterDays}
        />
        <RetentionField
          label="Delete after first play"
          hint={
            video.firstPlayedAt
              ? `First played ${new Date(video.firstPlayedAt).toLocaleDateString()}.`
              : 'Not played yet — this clock starts on the first play.'
          }
          value={deleteDaysAfterFirstPlay}
          onChange={setDeleteDaysAfterFirstPlay}
        />
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: tokens.color.danger }}>
            {error}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" type="submit" disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function EngagementVideosCard({ engagementId }: { engagementId: string }): JSX.Element {
  const canWrite = usePermission('video:write');
  const canDelete = usePermission('video:delete');
  const [rows, setRows] = useState<StaffVideoRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [defaults, setDefaults] = useState<VideoRetentionDefaults | null>(null);
  const [editing, setEditing] = useState<StaffVideoRow | null>(null);
  const [plays, setPlays] = useState<StaffVideoRow | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: StaffVideoRow[] }>(
        `/api/staff/engagements/${engagementId}/videos`,
      );
      setRows(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setRows([]);
    }
  }, [engagementId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openUpload(): Promise<void> {
    if (!defaults) setDefaults(await loadRetentionDefaults());
    setUploading(true);
  }

  async function remove(v: StaffVideoRow): Promise<void> {
    if (
      !window.confirm(
        `Delete "${v.title}"? The client loses access immediately. The play history is kept.`,
      )
    )
      return;
    try {
      await api(`/api/staff/videos/${v.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete_failed');
    }
  }

  return (
    <Card
      title="Videos"
      action={
        canWrite ? (
          <Button size="sm" variant="secondary" onClick={() => void openUpload()}>
            Upload video
          </Button>
        ) : undefined
      }
    >
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Record a walkthrough and the client watches it in the portal (phone or desktop). You see
        when it was played; it is removed automatically on the retention clocks you set.
      </p>
      {error && (
        <p style={{ fontSize: 12, color: tokens.color.danger }} role="alert">
          {error}
        </p>
      )}
      {rows === null ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : (
        <Table<StaffVideoRow>
          rows={rows}
          rowKey={(r) => r.id}
          empty="No videos yet."
          columns={[
            {
              key: 'title',
              header: 'Video',
              mobile: 'title',
              render: (r) => (
                <div style={{ display: 'grid' }}>
                  <span style={{ fontWeight: 500 }}>{r.title}</span>
                  <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    {formatBytes(r.sizeBytes)} · uploaded{' '}
                    {new Date(r.uploadedAt).toLocaleDateString()}
                  </span>
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              mobile: 'badge',
              render: (r) => {
                const p = videoStatusPill(r);
                return <Pill tone={p.tone}>{p.label}</Pill>;
              },
            },
            {
              key: 'plays',
              header: 'Plays',
              mobile: 'field',
              mobileLabel: 'Plays',
              render: (r) =>
                r.playCount === 0
                  ? '—'
                  : `${r.playCount}${r.maxProgressPct != null ? ` · ${Math.round(r.maxProgressPct)}% watched` : ''}`,
            },
            {
              key: 'replies',
              header: 'Replies',
              mobile: 'meta',
              render: (r) => (r.replyCount > 0 ? `${r.replyCount} in thread` : '—'),
            },
            {
              key: 'expires',
              header: 'Available',
              mobile: 'field',
              mobileLabel: 'Available',
              render: (r) => (r.status === 'AVAILABLE' ? formatAvailableUntil(r.expiresAt) : '—'),
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              mobile: 'actions',
              render: (r) => (
                <Menu
                  ariaLabel={`Actions for ${r.title}`}
                  items={[
                    { key: 'plays', label: 'View plays', onSelect: () => setPlays(r) },
                    {
                      key: 'edit',
                      label: 'Edit / extend dates',
                      onSelect: () => setEditing(r),
                      disabled: !canWrite || r.status !== 'AVAILABLE',
                      disabledReason: !canWrite
                        ? 'Requires video:write'
                        : 'Only available videos can be edited',
                    },
                    {
                      key: 'delete',
                      label: 'Delete now',
                      danger: true,
                      onSelect: () => void remove(r),
                      disabled: !canDelete || r.status === 'DELETED',
                      disabledReason: 'Requires video:delete',
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      )}

      {uploading && defaults && (
        <VideoUploadDialog
          engagementId={engagementId}
          defaults={defaults}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            void load();
          }}
        />
      )}
      {editing && (
        <VideoEditDialog
          video={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {plays && (
        <VideoPlaysModal videoId={plays.id} title={plays.title} onClose={() => setPlays(null)} />
      )}
    </Card>
  );
}
