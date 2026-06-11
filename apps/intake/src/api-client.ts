// SPDX-License-Identifier: Elastic-2.0
//
// Public intake API client. The intake surface is anonymous — no session
// cookie, no CSRF token. Every call targets /api/public/intake/* on the
// same origin (Caddy serves this SPA and proxies only that path here).

const BASE = '/api/public/intake';

export interface ApiError extends Error {
  status: number;
  body?: unknown;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { method?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'omit' });
  return parse<T>(res);
}

// Raw-body upload. The server reads the bytes directly (octet-stream) so we
// avoid base64 inflation and the JSON body-size cap; filename + mimeType
// ride in the query string.
export async function uploadRaw<T = unknown>(
  path: string,
  data: Blob,
  meta: { filename: string; mimeType: string },
): Promise<T> {
  const qs = new URLSearchParams({ filename: meta.filename, mimeType: meta.mimeType });
  const res = await fetch(`${BASE}${path}?${qs.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': meta.mimeType || 'application/octet-stream' },
    body: data,
    credentials: 'omit',
  });
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  const ct = res.headers.get('content-type') ?? '';
  const body: unknown = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : res.statusText,
    ) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}
