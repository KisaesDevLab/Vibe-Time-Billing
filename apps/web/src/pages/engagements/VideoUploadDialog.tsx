/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers (same posture as DropOffCard) */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Upload-a-video dialog for an engagement. Reserve → direct PUT with a
// real progress bar → complete. The modal is locked (no Escape / backdrop
// close) while a transfer is in flight.

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';

import { Button, Modal, tokens } from '@vibe/ui';

import { useVideoUpload } from '../../lib/use-video-upload';
import {
  VIDEO_ACCEPT,
  formatBytes,
  isMovFile,
  titleFromFilename,
  validateVideoFile,
} from '../../lib/video-upload';

export interface VideoRetentionDefaults {
  deleteAfterDays: number | null;
  deleteDaysAfterFirstPlay: number | null;
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

const labelStyle: CSSProperties = { fontSize: 11, color: tokens.color.textMuted };

export function RetentionField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  onChange: (v: number | null) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label style={labelStyle}>{label}</label>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="number"
          min={1}
          max={3650}
          value={value ?? ''}
          disabled={value === null}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(
              e.target.value === '' || !Number.isFinite(n) ? 1 : Math.max(1, Math.min(3650, n)),
            );
          }}
          style={{ ...inputStyle(), width: 90 }}
        />
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>days</span>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
          <input
            type="checkbox"
            checked={value === null}
            onChange={(e) => onChange(e.target.checked ? null : 30)}
          />
          No limit
        </label>
      </div>
      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{hint}</span>
    </div>
  );
}

export function VideoUploadDialog({
  engagementId,
  defaults,
  onClose,
  onUploaded,
}: {
  engagementId: string;
  defaults: VideoRetentionDefaults;
  onClose: () => void;
  onUploaded: () => void;
}): JSX.Element {
  const { state, start, abort, reset } = useVideoUpload(engagementId);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [deleteAfterDays, setDeleteAfterDays] = useState<number | null>(defaults.deleteAfterDays);
  const [deleteDaysAfterFirstPlay, setDeleteDaysAfterFirstPlay] = useState<number | null>(
    defaults.deleteDaysAfterFirstPlay,
  );
  const [notifyClient, setNotifyClient] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);

  const busy =
    state.phase === 'reserving' || state.phase === 'uploading' || state.phase === 'finalizing';
  // Aborting during 'finalizing' fires DELETE against a video whose
  // /complete is already in flight: either the row is hard-deleted and
  // complete 404s (a spurious error on a cancel), or complete wins and the
  // client is emailed about a video that is then deleted. There is nothing
  // left to cancel by then, so don't offer it.
  const cancellable = state.phase === 'reserving' || state.phase === 'uploading';

  useEffect(() => {
    if (state.phase === 'done') onUploaded();
    // onUploaded is stable enough for this dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  function pick(f: File | null): void {
    setFile(f);
    setFileError(f ? validateVideoFile(f) : null);
    if (f && !title.trim()) setTitle(titleFromFilename(f.name));
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!file || busy) return;
    const invalid = validateVideoFile(file);
    if (invalid) {
      setFileError(invalid);
      return;
    }
    if (!title.trim()) {
      setFileError('Give the video a title the client will recognise.');
      return;
    }
    setFileError(null);
    await start(file, {
      title: title.trim(),
      message: message.trim() ? message.trim() : null,
      deleteAfterDays,
      deleteDaysAfterFirstPlay,
      notifyClient,
    });
  }

  const phaseLabel =
    state.phase === 'reserving'
      ? 'Preparing upload…'
      : state.phase === 'uploading'
        ? state.progress < 0
          ? 'Uploading…'
          : `Uploading… ${state.progress}%`
        : state.phase === 'finalizing'
          ? 'Finalising…'
          : null;

  return (
    <Modal
      title="Upload a video for the client"
      onClose={busy ? undefined : onClose}
      maxWidth={560}
    >
      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={labelStyle}>Video file (MP4, MOV, or WebM · up to 2 GB)</label>
          <input
            type="file"
            accept={VIDEO_ACCEPT}
            disabled={busy}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
          {file && (
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              {file.name} · {formatBytes(file.size)}
            </span>
          )}
          {file && isMovFile(file) && (
            <span style={{ fontSize: 12, color: tokens.color.warning }}>
              Some .mov files (iPhone HEVC/H.265) will not play on Windows or Android browsers. If
              the client reports a playback error, re-export as MP4 (H.264).
            </span>
          )}
        </div>

        <div style={{ display: 'grid', gap: 4 }}>
          <label style={labelStyle}>Title (shown to the client)</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            style={inputStyle()}
            disabled={busy}
            required
          />
        </div>

        <div style={{ display: 'grid', gap: 4 }}>
          <label style={labelStyle}>
            Message (optional — shown under the player and in the email)
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={busy}
            style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        <RetentionField
          label="Delete after upload"
          hint="Removed this many days after upload, watched or not."
          value={deleteAfterDays}
          onChange={setDeleteAfterDays}
        />
        <RetentionField
          label="Delete after first play"
          hint="Removed this many days after the client first presses play. Whichever comes first wins."
          value={deleteDaysAfterFirstPlay}
          onChange={setDeleteDaysAfterFirstPlay}
        />

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={notifyClient}
            disabled={busy}
            onChange={(e) => setNotifyClient(e.target.checked)}
          />
          Notify the client (portal, email, and text)
        </label>

        {(fileError || state.error) && (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: tokens.color.danger }}>
            {fileError ?? state.error}
          </p>
        )}

        {phaseLabel && (
          <div style={{ display: 'grid', gap: 6 }}>
            <div
              aria-hidden
              style={{
                width: '100%',
                height: 8,
                borderRadius: 4,
                background: tokens.color.border,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: state.progress < 0 ? '100%' : `${state.progress}%`,
                  height: '100%',
                  background: tokens.color.accent,
                  opacity: state.progress < 0 ? 0.5 : 1,
                  transition: 'width 200ms linear',
                }}
              />
            </div>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{phaseLabel}</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {busy ? (
            <Button size="sm" variant="ghost" type="button" onClick={abort} disabled={!cancellable}>
              {cancellable ? 'Cancel upload' : 'Finishing…'}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" type="button" onClick={onClose}>
                Close
              </Button>
              {state.phase === 'error' && (
                <Button size="sm" variant="secondary" type="button" onClick={reset}>
                  Try again
                </Button>
              )}
              <Button size="sm" type="submit" disabled={!file || Boolean(fileError)}>
                Upload
              </Button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
