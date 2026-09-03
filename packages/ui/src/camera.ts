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
    // `ideal` ONLY. `min`/`max` are REQUIRED constraints: a camera that
    // cannot reach them makes getUserMedia reject with OverconstrainedError
    // rather than degrade. A 640x480 laptop webcam (the intake page is used
    // on desktop too) or an older Android sensor would lose the scanner
    // entirely — the opposite of what this constraint set is for.
    width: { ideal: 2560 },
    height: { ideal: 1440 },
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
 * populated after a permission grant, so call this once a stream is live.
 *
 * Conservative by design: this only ever moves BETWEEN positively
 * identified rear lenses. Device labels are empty before permission is
 * granted and are localised on many Android builds ("Rückkamera",
 * "후면 카메라"), so without a positive rear match there is no way to tell
 * a main lens from a selfie camera — guessing there would replace a
 * working rear stream with a front-facing one. Returns null whenever
 * there is no clear winner, meaning "keep the current track".
 */
export function pickRearCamera(
  devices: readonly CameraDeviceLike[],
  currentDeviceId?: string | null,
): CameraDeviceLike | null {
  const cams = devices.filter((d) => d.kind === 'videoinput');
  if (cams.length < 2) return null;
  // Firefox omits deviceId from getSettings(), so we cannot tell which
  // lens we are already on. Never swap blind.
  if (!currentDeviceId) return null;
  const rear = cams.filter((d) => REAR_HINT.test(d.label) && !/\bfront\b/i.test(d.label));
  // No label says "rear" — unlabeled or non-English. Keep what we have.
  if (rear.length === 0) return null;
  const winner = rear.find((d) => !AVOID_HINT.test(d.label)) ?? null;
  if (!winner || winner.deviceId === currentDeviceId) return null;
  // Never bounce a lens that already looks like the plain main camera.
  const current = cams.find((d) => d.deviceId === currentDeviceId);
  if (current && REAR_HINT.test(current.label) && !AVOID_HINT.test(current.label)) return null;
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
