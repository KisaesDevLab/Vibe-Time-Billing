// SPDX-License-Identifier: Elastic-2.0
//
// Phone document scanner. Opens the rear camera (getUserMedia), lets the
// visitor snap multiple pages, and hands each captured frame back as a JPEG
// blob. The worker (Phase D) assembles a batch of images into one PDF.
//
// Deferred enhancement: jscanify/OpenCV auto edge-detection + perspective
// crop. v1 captures the full frame — robust and dependency-free.

import { useEffect, useRef, useState } from 'react';

import { tokens } from '@vibe/ui';

interface Props {
  onCapture: (blob: Blob) => void;
  onClose: () => void;
}

export function CameraCapture({ onCapture, onClose }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function start(): Promise<void> {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
      } catch {
        if (!cancelled) setError('Could not access the camera. Check permissions or use Upload.');
      }
    }
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function snap(): void {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          onCapture(blob);
          setCount((c) => c + 1);
        }
      },
      'image/jpeg',
      0.9,
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan a document"
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        zIndex: 80,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {error ? (
          <div
            style={{
              color: '#fff',
              padding: 24,
              display: 'flex',
              height: '100%',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            {error}
          </div>
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
        {count > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 16,
              left: 16,
              background: tokens.color.accent,
              color: '#fff',
              borderRadius: tokens.radius.pill,
              padding: '4px 12px',
              fontSize: 13,
            }}
          >
            {count} page{count === 1 ? '' : 's'} captured
          </span>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: 16,
          background: '#111',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: '10px 16px',
            background: 'transparent',
            color: '#fff',
            border: '1px solid #444',
            borderRadius: tokens.radius.sm,
            fontSize: 15,
          }}
        >
          {count > 0 ? 'Done' : 'Cancel'}
        </button>
        <button
          type="button"
          onClick={snap}
          disabled={Boolean(error)}
          aria-label="Capture page"
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            background: '#fff',
            border: '4px solid #888',
            cursor: error ? 'not-allowed' : 'pointer',
          }}
        />
        <span style={{ width: 92 }} aria-hidden />
      </div>
    </div>
  );
}
