// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { buildScanConstraints, describeCameraError, hasCameraApi, pickRearCamera } from './camera';

const cam = (deviceId: string, label: string) => ({ deviceId, label, kind: 'videoinput' });

describe('hasCameraApi', () => {
  it('is false in WebViews without mediaDevices', () => {
    expect(hasCameraApi({ mediaDevices: undefined } as unknown as Navigator)).toBe(false);
    expect(hasCameraApi(undefined)).toBe(false);
    expect(
      hasCameraApi({ mediaDevices: { getUserMedia: async () => null } } as unknown as Navigator),
    ).toBe(true);
  });
});

describe('buildScanConstraints', () => {
  it('asks for a readable resolution and the rear lens by default', () => {
    const c = buildScanConstraints();
    const v = c.video as MediaTrackConstraints;
    expect(v.facingMode).toEqual({ ideal: 'environment' });
    expect((v.width as { ideal: number }).ideal).toBeGreaterThanOrEqual(1920);
    expect(v.deviceId).toBeUndefined();
    expect(c.audio).toBe(false);
  });
  it('pins a device id exactly when given', () => {
    const v = buildScanConstraints('abc').video as MediaTrackConstraints;
    expect(v.deviceId).toEqual({ exact: 'abc' });
    expect(v.facingMode).toBeUndefined();
  });
});

describe('pickRearCamera', () => {
  it('returns null with a single camera', () => {
    expect(pickRearCamera([cam('a', 'camera2 0, facing back')], 'a')).toBeNull();
  });
  it('prefers the plain back camera over ultra-wide/macro (Samsung style)', () => {
    const devices = [
      cam('front', 'camera2 1, facing front'),
      cam('uw', 'camera2 2, facing back (ultra wide)'),
      cam('main', 'camera2 0, facing back'),
      cam('tele', 'camera2 3, facing back (telephoto)'),
    ];
    expect(pickRearCamera(devices, 'uw')?.deviceId).toBe('main');
    // Already on the main lens → no switch.
    expect(pickRearCamera(devices, 'main')).toBeNull();
  });
  it('does not switch away from an unlabeled current device when labels are empty', () => {
    const devices = [cam('a', ''), cam('b', '')];
    // No hints at all: first device wins only if we are not already on it.
    expect(pickRearCamera(devices, 'a')).toBeNull();
    expect(pickRearCamera(devices, 'b')?.deviceId).toBe('a');
  });
});

describe('describeCameraError', () => {
  it('maps the common DOMException names', () => {
    expect(describeCameraError({ name: 'NotAllowedError' }).title).toMatch(/blocked/);
    expect(describeCameraError({ name: 'NotReadableError' }).title).toMatch(/busy/);
    expect(describeCameraError({ name: 'NotFoundError' }).title).toMatch(/No usable camera/);
    expect(describeCameraError(new TypeError('x')).title).toMatch(/can't open/);
    expect(describeCameraError(null).detail).toMatch(/Take a photo/);
  });
});
