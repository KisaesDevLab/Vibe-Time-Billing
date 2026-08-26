// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Reusable QR scanner dialog — rear camera + jsQR decode loop. Built for
// the client-QR workflow (route sheets print the client UUID top-right;
// staff on an iPad scan sheets to select clients) but generic: the host
// passes an `onScan` handler and optionally renders a running list below
// the viewfinder via `children`.
//
// Continuous mode: the dialog stays open after a hit so multiple codes
// can be scanned in one session; the same payload is debounced for a few
// seconds so a code held in frame fires once. Camera pattern mirrors
// apps/intake CameraCapture (getUserMedia, ideal environment camera,
// track cleanup). Decode runs on a downscaled canvas — jsQR is O(pixels)
// and full 1080p frames stutter on iPads.

import jsQR from 'jsqr';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Modal, tokens } from '@vibe/ui';

export interface ScanFeedback {
  tone: 'success' | 'error' | 'info';
  message: string;
}

export interface QrScannerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called once per distinct decoded payload (debounced ~2.5s for the
   *  same payload). The returned feedback renders as a banner over the
   *  viewfinder. */
  onScan: (payload: string) => ScanFeedback | void;
  title?: string;
  /** Rendered under the viewfinder — e.g. the running list of scanned
   *  clients. */
  children?: React.ReactNode;
}

const DECODE_INTERVAL_MS = 120;
const SAME_PAYLOAD_DEBOUNCE_MS = 2500;
const MAX_DECODE_EDGE_PX = 480;

type CamState = 'starting' | 'live' | 'denied' | 'no-camera' | 'insecure' | 'failed';

function toneColor(tone: ScanFeedback['tone']): string {
  return tone === 'success'
    ? tokens.color.success
    : tone === 'error'
      ? tokens.color.danger
      : tokens.color.accent;
}

export function QrScannerDialog({
  open,
  onClose,
  onScan,
  title = 'Scan QR code',
  children,
}: QrScannerDialogProps): JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastScanRef = useRef<{ payload: string; at: number } | null>(null);
  const decodingRef = useRef(false);
  const [cam, setCam] = useState<CamState>('starting');
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [flash, setFlash] = useState<ScanFeedback['tone'] | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  // Bumped by the Retry button to re-run the camera effect.
  const [attempt, setAttempt] = useState(0);

  const stopStream = useCallback((): void => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Camera lifecycle — start on open, stop on close/unmount.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCam('starting');
    setFeedback(null);
    setTorchOn(false);
    setTorchAvailable(false);
    lastScanRef.current = null;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCam(window.isSecureContext === false ? 'insecure' : 'no-camera');
      return;
    }

    async function start(): Promise<void> {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // ideal, not exact: desktops with only a front camera still work.
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        // Torch is Android/Chrome-only; iOS never advertises it and the
        // button simply doesn't render there.
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & {
              torch?: boolean;
            })
          | undefined;
        setTorchAvailable(caps?.torch === true);
        setCam('live');
      } catch (err) {
        if (cancelled) return;
        const name = (err as { name?: string }).name;
        setCam(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'denied'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'no-camera'
              : 'failed',
        );
      }
    }
    void start();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [open, attempt, stopStream]);

  // Decode loop.
  useEffect(() => {
    if (!open || cam !== 'live') return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || decodingRef.current) return;
      if (document.visibilityState === 'hidden') return; // battery: idle when backgrounded
      decodingRef.current = true;
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return;
        const scale = Math.min(1, MAX_DECODE_EDGE_PX / Math.max(vw, vh));
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);
        const canvas = (canvasRef.current ??= document.createElement('canvas'));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (!code || !code.data) return;
        const now = Date.now();
        const last = lastScanRef.current;
        if (last && last.payload === code.data && now - last.at < SAME_PAYLOAD_DEBOUNCE_MS) {
          return;
        }
        lastScanRef.current = { payload: code.data, at: now };
        const fb = onScan(code.data) ?? null;
        setFeedback(fb);
        setFlash(fb?.tone ?? 'success');
        window.setTimeout(() => setFlash(null), 450);
      } finally {
        decodingRef.current = false;
      }
    }, DECODE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, cam, onScan]);

  async function toggleTorch(): Promise<void> {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet & { torch: boolean }],
      });
      setTorchOn(next);
    } catch {
      // Torch not actually available — hide the button.
      setTorchAvailable(false);
    }
  }

  if (!open) return null;

  const errorCopy: Partial<Record<CamState, string>> = {
    denied:
      'Camera permission denied. On an iPad, allow camera access under Settings → Safari → Camera (or the site permissions prompt), then retry.',
    'no-camera': 'No camera found on this device.',
    insecure: 'Camera access requires a secure (HTTPS) connection.',
    failed: 'Could not start the camera.',
  };

  return (
    <Modal title={title} onClose={onClose} minWidth={420} maxWidth={520}>
      <div style={{ display: 'grid', gap: tokens.space.sm }}>
        <div
          style={{
            position: 'relative',
            width: '100%',
            aspectRatio: '4 / 3',
            background: '#000',
            borderRadius: tokens.radius.md,
            overflow: 'hidden',
            // Success/error pulse so a scan is unmistakable at arm's length.
            border: `3px solid ${flash ? toneColor(flash) : 'transparent'}`,
            transition: 'border-color 150ms ease',
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          {cam === 'starting' && (
            <p
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 13,
                margin: 0,
              }}
            >
              Starting camera…
            </p>
          )}
          {cam !== 'starting' && cam !== 'live' && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                padding: 16,
                textAlign: 'center',
                color: '#fff',
                fontSize: 13,
              }}
            >
              <span>{errorCopy[cam]}</span>
              {cam !== 'insecure' && (
                <button
                  type="button"
                  onClick={() => setAttempt((n) => n + 1)}
                  style={{
                    minHeight: 44,
                    padding: '0 20px',
                    borderRadius: tokens.radius.md,
                    border: '1px solid #fff',
                    background: 'transparent',
                    color: '#fff',
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {feedback && (
            <div
              role="status"
              style={{
                position: 'absolute',
                left: 8,
                right: 8,
                bottom: 8,
                padding: '8px 12px',
                borderRadius: tokens.radius.md,
                background: 'rgba(0,0,0,0.75)',
                color: toneColor(feedback.tone),
                fontSize: 14,
                fontWeight: 600,
                textAlign: 'center',
              }}
            >
              {feedback.message}
            </div>
          )}
          {torchAvailable && cam === 'live' && (
            <button
              type="button"
              onClick={() => void toggleTorch()}
              aria-label={torchOn ? 'Turn torch off' : 'Turn torch on'}
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                width: 44,
                height: 44,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: torchOn ? tokens.color.warning : 'rgba(0,0,0,0.55)',
                color: '#fff',
                fontSize: 18,
                cursor: 'pointer',
              }}
            >
              {'\u{1F526}'}
            </button>
          )}
        </div>
        <p style={{ margin: 0, fontSize: 12, color: tokens.color.textMuted }}>
          Point the camera at the QR code in the top-right corner of a route sheet. Keep scanning to
          add more clients.
        </p>
        {children}
      </div>
    </Modal>
  );
}
