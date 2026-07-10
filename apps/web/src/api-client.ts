// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Thin fetch wrapper. Carries the CSRF token on mutating requests
// (Phase 3 CSRF middleware double-submit cookie pattern).

const CSRF_KEY = '__vibe_csrf';

export function setCsrfToken(token: string | null): void {
  if (token == null) sessionStorage.removeItem(CSRF_KEY);
  else sessionStorage.setItem(CSRF_KEY, token);
}

export function getCsrfToken(): string | null {
  return sessionStorage.getItem(CSRF_KEY);
}

export interface ApiError extends Error {
  status: number;
  body?: unknown;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { method?: string } = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
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
