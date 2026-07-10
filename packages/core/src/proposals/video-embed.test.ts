// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0

import { describe, expect, it } from 'vitest';

import { parseVideoUrl } from './video-embed';

describe('parseVideoUrl', () => {
  it('parses youtube watch URLs', () => {
    expect(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('parses youtu.be short URLs', () => {
    expect(parseVideoUrl('https://youtu.be/abc12345678')).toMatchObject({
      provider: 'youtube',
      videoId: 'abc12345678',
    });
  });

  it('parses youtube embed URLs', () => {
    expect(parseVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toMatchObject({
      provider: 'youtube',
    });
  });

  it('parses vimeo URLs', () => {
    expect(parseVideoUrl('https://vimeo.com/123456789')).toEqual({
      provider: 'vimeo',
      videoId: '123456789',
      embedUrl: 'https://player.vimeo.com/video/123456789',
    });
  });

  it('parses vimeo /video/ URLs', () => {
    expect(parseVideoUrl('https://vimeo.com/video/987654321')).toMatchObject({
      provider: 'vimeo',
      videoId: '987654321',
    });
  });

  it('parses loom share URLs', () => {
    const r = parseVideoUrl('https://www.loom.com/share/abc1234567890def');
    expect(r).toMatchObject({
      provider: 'loom',
      videoId: 'abc1234567890def',
      embedUrl: 'https://www.loom.com/embed/abc1234567890def',
    });
  });

  it('returns null for invalid url', () => {
    expect(parseVideoUrl('not a url')).toBeNull();
    expect(parseVideoUrl('')).toBeNull();
  });

  it('returns null for unrecognized hosts', () => {
    expect(parseVideoUrl('https://example.com/video/123')).toBeNull();
  });

  it('returns null for youtube without an id', () => {
    expect(parseVideoUrl('https://www.youtube.com')).toBeNull();
    expect(parseVideoUrl('https://www.youtube.com/watch?v=')).toBeNull();
  });

  it('handles m.youtube.com', () => {
    expect(parseVideoUrl('https://m.youtube.com/watch?v=abcdef12345')).toMatchObject({
      provider: 'youtube',
      videoId: 'abcdef12345',
    });
  });
});
