// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Camera helpers shared by the intake scanner and the portal. Pure and
// DOM-free where possible so they unit-test under node.
//
// Background (Android field reports, 2026-09): the in-browser scanner
// asked for `facingMode: environment` only. Android Chrome then hands back
// a 640×480 stream, multi-camera Samsungs sometimes pick an ultra-wide or
// macro lens with no autofocus, and in-app WebViews (Gmail, Facebook,
// LinkedIn) have no getUserMedia at all. The fixes: ask for a real
// resolution + continuous focus, prefer the main rear lens, and always
// offer the phone's native camera app via <input capture> as a fallback.

/** Accept list for a native "take a photo" input. JPEG/PNG only: the
 *  intake worker embeds pages into a PDF with pdf-lib, which reads only
 *  those two, and every phone camera app produces JPEG. */
export const PHOTO_CAPTURE_ACCEPT = 'image/jpeg,image/png';

export function hasCameraApi(
  nav: Pick<Navigator, 'mediaDevices'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
): boolean {
  return Boolean(nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function');
}

/** Constraints for a document scan: rear camera, a resolution that can
 *  actually be read back, and continuous autofocus where the platform
 *  honours it. `deviceId` pins the lens once we know which one we want. */
export function buildScanConstraints(deviceId?: string | null): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: 2560, min: 1024 },
    height: { ideal: 1440, min: 576 },
    // reason: focusMode is a real MediaTrackConstraint on Android Chrome
    // but not in lib.dom's type yet.
    advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };
  return { video, audio: false };
}

export interface CameraDeviceLike {
  deviceId: string;
  kind: string;
  label: string;
}

const REAR_HINT = /\b(back|rear|environment|world)\b/i;
const AVOID_HINT = /\b(ultra|wide|tele|zoom|macro|depth|ir|infrared|bokeh|front|user|face)\b/i;

/**
 * Pick the main rear camera from enumerateDevices(). Labels are only
 * populated after a permission grant, so call this once a stream is
 * live. Returns null when there is no clear winner (keep the current
 * track in that case).
 */
export function pickRearCamera(
  devices: readonly CameraDeviceLike[],
  currentDeviceId?: string | null,
): CameraDeviceLike | null {
  const cams = devices.filter((d) => d.kind === 'videoinput');
  if (cams.length < 2) return null;
  const rear = cams.filter((d) => REAR_HINT.test(d.label) && !/\bfront\b/i.test(d.label));
  const pool = rear.length > 0 ? rear : cams;
  const plain = pool.filter((d) => !AVOID_HINT.test(d.label));
  const winner = plain[0] ?? pool[0] ?? null;
  if (!winner || winner.deviceId === currentDeviceId) return null;
  // Only switch when the current lens looks like a special lens (or is
  // unknown) — never bounce a good main camera.
  const current = cams.find((d) => d.deviceId === currentDeviceId);
  if (current && !AVOID_HINT.test(current.label) && REAR_HINT.test(current.label)) return null;
  return winner;
}

export interface CameraErrorCopy {
  title: string;
  detail: string;
}

/** Turn a getUserMedia rejection into something a client can act on. */
export function describeCameraError(err: unknown): CameraErrorCopy {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        title: 'Camera access is blocked',
        detail:
          'Allow the camera for this site (tap the lock icon in the address bar → Permissions → Camera), or use "Take a photo" below to open your phone\'s camera app instead.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return {
        title: 'No usable camera found',
        detail: 'Use "Take a photo" below to open your phone\'s camera app, or upload a file.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        title: 'The camera is busy',
        detail:
          'Another app may be using it. Close other camera apps and try again, or use "Take a photo" below.',
      };
    default:
      return {
        title: "This browser can't open the camera",
        detail:
          'Some in-app browsers (email and social apps) block it. Use "Take a photo" below to open your phone\'s camera app, or open this page in Chrome or Safari.',
      };
  }
}
