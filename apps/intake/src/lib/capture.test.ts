// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { describeUploadError, inferCaptureMime } from './capture';

describe('inferCaptureMime', () => {
  it('trusts a type the browser reported', () => {
    expect(inferCaptureMime({ type: 'image/png' }, 'a.jpg')).toBe('image/png');
  });
  it('never guesses jpeg for a HEIC with no reported type', () => {
    // The Android WebView case that used to kill the whole session's PDF.
    expect(inferCaptureMime({ type: '' }, 'IMG_0042.HEIC')).toBe('image/heic');
    expect(inferCaptureMime({ type: '' }, 'x.heif')).toBe('image/heif');
  });
  it('falls back to extension for the ordinary cases', () => {
    expect(inferCaptureMime({ type: '' }, 'scan.jpg')).toBe('image/jpeg');
    expect(inferCaptureMime({ type: '' }, 'scan.jpeg')).toBe('image/jpeg');
    expect(inferCaptureMime({ type: '' }, 'scan.PNG')).toBe('image/png');
  });
  it('stays honest when nothing identifies the file', () => {
    expect(inferCaptureMime({ type: '' }, 'noext')).toBe('application/octet-stream');
    expect(inferCaptureMime({ type: '' })).toBe('application/octet-stream');
  });
});

describe('describeUploadError', () => {
  it('names the file and explains the code', () => {
    expect(describeUploadError('unsupported_type', 'x.heic')).toContain('x.heic');
    expect(describeUploadError('unsupported_type', 'x.heic')).toMatch(/can't accept/);
    expect(describeUploadError('file_too_large', 'big.mp4')).toMatch(/25 MB/);
    expect(describeUploadError('weird_code', 'y.pdf')).toContain('y.pdf');
  });
});
