// SPDX-License-Identifier: Elastic-2.0
//
// P05 — Video URL → embed iframe URL parser.
//
// Supports YouTube (youtube.com, youtu.be), Vimeo (vimeo.com), and
// Loom (loom.com/share). Returns null for anything unrecognized so
// the renderer can show a friendly fallback instead of an iframe
// pointing at attacker-controlled HTML.

export type VideoProvider = 'youtube' | 'vimeo' | 'loom';

export interface ParsedVideo {
  provider: VideoProvider;
  embedUrl: string;
  // Stable identifier for analytics + dedup; not used by renderer.
  videoId: string;
}

export function parseVideoUrl(input: string): ParsedVideo | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');

  // YouTube — full + short forms
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{6,15}$/.test(v)) {
      return {
        provider: 'youtube',
        videoId: v,
        embedUrl: `https://www.youtube.com/embed/${v}`,
      };
    }
    // youtube.com/embed/<id>
    const embedMatch = /^\/embed\/([A-Za-z0-9_-]{6,15})$/.exec(url.pathname);
    if (embedMatch) {
      return {
        provider: 'youtube',
        videoId: embedMatch[1]!,
        embedUrl: `https://www.youtube.com/embed/${embedMatch[1]}`,
      };
    }
    return null;
  }
  if (host === 'youtu.be') {
    const m = /^\/([A-Za-z0-9_-]{6,15})$/.exec(url.pathname);
    if (m) {
      return {
        provider: 'youtube',
        videoId: m[1]!,
        embedUrl: `https://www.youtube.com/embed/${m[1]}`,
      };
    }
    return null;
  }

  // Vimeo
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/)?(\d{6,12})/.exec(url.pathname);
    if (m) {
      return {
        provider: 'vimeo',
        videoId: m[1]!,
        embedUrl: `https://player.vimeo.com/video/${m[1]}`,
      };
    }
    return null;
  }

  // Loom — /share/<hex>
  if (host === 'loom.com') {
    const m = /^\/(?:share|embed)\/([0-9a-f]{16,64})/.exec(url.pathname);
    if (m) {
      return {
        provider: 'loom',
        videoId: m[1]!,
        embedUrl: `https://www.loom.com/embed/${m[1]}`,
      };
    }
    return null;
  }

  return null;
}
