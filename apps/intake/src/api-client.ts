// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
