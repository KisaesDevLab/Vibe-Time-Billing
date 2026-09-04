// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Engagement-video upload: reserve → PUT straight to storage → complete.
//
// The PUT uses XMLHttpRequest rather than fetch because only XHR exposes
// upload progress, and a 2 GB file without a progress bar is
// indistinguishable from a hung browser. `xhr.send(file)` streams from
// disk — the file is never materialised in JS memory. The dev-only
// `mock-presign://` path (mock storage) does buffer + base64 the body,
// exactly like ClientFilesTab; that is acceptable for local development.

import { useCallback, useRef, useState } from 'react';

import { api, type ApiError } from '../api-client';
import { COMPLETE_RETRY_DELAYS_MS, resolveVideoMime, validateVideoFile } from './video-upload';

export type UploadPhase = 'idle' | 'reserving' | 'uploading' | 'finalizing' | 'done' | 'error';

export interface VideoUploadMeta {
  title: string;
  message: string | null;
  deleteAfterDays: number | null;
  deleteDaysAfterFirstPlay: number | null;
  notifyClient: boolean;
}

export interface VideoUploadState {
  phase: UploadPhase;
  /** 0..100 for the PUT leg; -1 = indeterminate (mock storage). */
  progress: number;
  error: string | null;
}

interface ReserveResponse {
  videoId: string;
  uploadUrl: string;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function completeWithRetry<T>(videoId: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await api<T>(`/api/staff/videos/${videoId}/complete`, { method: 'POST', body: '{}' });
    } catch (err) {
      const e = err as ApiError;
      const body = (e.body ?? {}) as { error?: string };
      const retryable = e.status === 409 && body.error === 'object_not_yet_landed';
      if (!retryable || i >= COMPLETE_RETRY_DELAYS_MS.length) throw err;
      await sleep(COMPLETE_RETRY_DELAYS_MS[i]!);
    }
  }
}

export function useVideoUpload(engagementId: string): {
  state: VideoUploadState;
  start: <T = unknown>(file: File, meta: VideoUploadMeta) => Promise<T | null>;
  abort: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<VideoUploadState>({ phase: 'idle', progress: 0, error: null });
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const reservedRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    xhrRef.current = null;
    reservedRef.current = null;
    setState({ phase: 'idle', progress: 0, error: null });
  }, []);

  const abort = useCallback(() => {
    xhrRef.current?.abort();
    const id = reservedRef.current;
    reservedRef.current = null;
    if (id) {
      // Best-effort: drop the reservation so the row doesn't sit as
      // PENDING_UPLOAD until the janitor gets to it.
      void api(`/api/staff/videos/${id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    setState({ phase: 'idle', progress: 0, error: null });
  }, []);

  const start = useCallback(
    async <T = unknown>(file: File, meta: VideoUploadMeta): Promise<T | null> => {
      const invalid = validateVideoFile(file);
      if (invalid) {
        setState({ phase: 'error', progress: 0, error: invalid });
        return null;
      }
      const mimeType = resolveVideoMime(file)!;
      setState({ phase: 'reserving', progress: 0, error: null });
      try {
        const reserve = await api<ReserveResponse>(
          `/api/staff/engagements/${engagementId}/videos`,
          {
            method: 'POST',
            body: JSON.stringify({
              title: meta.title,
              message: meta.message,
              originalFilename: file.name,
              sizeBytes: file.size,
              mimeType,
              deleteAfterDays: meta.deleteAfterDays,
              deleteDaysAfterFirstPlay: meta.deleteDaysAfterFirstPlay,
              notifyClient: meta.notifyClient,
            }),
          },
        );
        reservedRef.current = reserve.videoId;

        if (reserve.uploadUrl.startsWith('mock-presign://')) {
          setState({ phase: 'uploading', progress: -1, error: null });
          const buf = await file.arrayBuffer();
          await api('/api/staff/admin/storage/upload-mock', {
            method: 'POST',
            body: JSON.stringify({
              url: reserve.uploadUrl,
              contentBase64: bufferToBase64(buf),
              contentType: mimeType,
            }),
          });
        } else {
          setState({ phase: 'uploading', progress: 0, error: null });
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhrRef.current = xhr;
            xhr.open('PUT', reserve.uploadUrl);
            // Content-Type is part of the SigV4 signature when the server
            // presigned with it — send exactly what was reserved.
            xhr.setRequestHeader('Content-Type', mimeType);
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                setState({
                  phase: 'uploading',
                  progress: Math.round((e.loaded / e.total) * 100),
                  error: null,
                });
              }
            };
            xhr.onload = () =>
              xhr.status >= 200 && xhr.status < 300
                ? resolve()
                : reject(new Error(`upload_failed_${xhr.status}`));
            xhr.onerror = () => reject(new Error('upload_network_error'));
            xhr.onabort = () => reject(new Error('upload_aborted'));
            xhr.send(file);
          });
          xhrRef.current = null;
        }

        setState({ phase: 'finalizing', progress: 100, error: null });
        const result = await completeWithRetry<T>(reserve.videoId);
        reservedRef.current = null;
        setState({ phase: 'done', progress: 100, error: null });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'upload_failed';
        if (message === 'upload_aborted') return null;
        setState({ phase: 'error', progress: 0, error: message });
        return null;
      }
    },
    [engagementId],
  );

  return { state, start, abort, reset };
}
