// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-2 — OAuth 2.0 authorization-code flow for Microsoft 365 + Google
// Calendar, plus token refresh and calendar listing. Implemented with
// plain fetch against the documented REST endpoints (we deliberately skip
// the @microsoft/microsoft-graph-client + googleapis SDKs — they'd add
// bundle weight to the API/worker for endpoints we call directly).
//
// v1 is read-only: Microsoft `Calendars.Read offline_access User.Read`,
// Google `calendar.readonly`. Write-back (CAL-9) expands the scopes behind
// FEATURE_CALENDAR_WRITE.

export type CalendarProvider = 'microsoft' | 'google';

type Fetch = typeof fetch;

export const SCOPES: Record<CalendarProvider, string> = {
  microsoft: 'offline_access User.Read Calendars.Read',
  google: 'https://www.googleapis.com/auth/calendar.readonly',
};

export interface AuthorizeInput {
  clientId: string;
  tenantId?: string | null;
  redirectUri: string;
  state: string;
}

export function buildAuthorizeUrl(provider: CalendarProvider, input: AuthorizeInput): string {
  if (provider === 'microsoft') {
    const tenant = input.tenantId || 'common';
    const p = new URLSearchParams({
      client_id: input.clientId,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      response_mode: 'query',
      scope: SCOPES.microsoft,
      state: input.state,
    });
    return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${p}`;
  }
  const p = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: SCOPES.google,
    access_type: 'offline', // ask Google for a refresh token
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function tokenUrl(provider: CalendarProvider, tenantId?: string | null): string {
  return provider === 'microsoft'
    ? `https://login.microsoftonline.com/${encodeURIComponent(tenantId || 'common')}/oauth2/v2.0/token`
    : 'https://oauth2.googleapis.com/token';
}

function toTokenSet(json: TokenResponse, now: Date): TokenSet {
  return {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(now.getTime() + (json.expires_in ?? 3600) * 1000),
    scope: json.scope ?? null,
  };
}

export interface ExchangeInput {
  clientId: string;
  clientSecret: string;
  tenantId?: string | null;
  redirectUri: string;
  code: string;
}

export async function exchangeCode(
  provider: CalendarProvider,
  input: ExchangeInput,
  fetchImpl: Fetch = fetch,
  now: Date = new Date(),
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });
  if (provider === 'microsoft') body.set('scope', SCOPES.microsoft);
  const res = await fetchImpl(tokenUrl(provider, input.tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`oauth_exchange_failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  return toTokenSet(json, now);
}

export interface RefreshInput {
  clientId: string;
  clientSecret: string;
  tenantId?: string | null;
  refreshToken: string;
}

export async function refreshTokens(
  provider: CalendarProvider,
  input: RefreshInput,
  fetchImpl: Fetch = fetch,
  now: Date = new Date(),
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
  if (provider === 'microsoft') body.set('scope', SCOPES.microsoft);
  const res = await fetchImpl(tokenUrl(provider, input.tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`oauth_refresh_failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  // Google often omits a new refresh_token on refresh — keep the old one.
  const set = toTokenSet(json, now);
  if (!set.refreshToken) set.refreshToken = input.refreshToken;
  return set;
}

export interface ProviderIdentity {
  providerUserId: string | null;
  providerEmail: string | null;
}

/** Resolve the connected account's id + email (best-effort). */
export async function fetchIdentity(
  provider: CalendarProvider,
  accessToken: string,
  fetchImpl: Fetch = fetch,
): Promise<ProviderIdentity> {
  try {
    if (provider === 'microsoft') {
      const res = await fetchImpl('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const j = (await res.json().catch(() => ({}))) as {
        id?: string;
        mail?: string;
        userPrincipalName?: string;
      };
      return { providerUserId: j.id ?? null, providerEmail: j.mail ?? j.userPrincipalName ?? null };
    }
    const res = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string; email?: string };
    return { providerUserId: j.id ?? null, providerEmail: j.email ?? null };
  } catch {
    return { providerUserId: null, providerEmail: null };
  }
}

export interface ProviderCalendar {
  calendarId: string;
  name: string;
  color: string | null;
  isPrimary: boolean;
}

/** List the connected account's calendars. */
export async function listCalendars(
  provider: CalendarProvider,
  accessToken: string,
  fetchImpl: Fetch = fetch,
): Promise<ProviderCalendar[]> {
  if (provider === 'microsoft') {
    const res = await fetchImpl('https://graph.microsoft.com/v1.0/me/calendars?$top=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const j = (await res.json().catch(() => ({}))) as {
      value?: Array<{ id: string; name: string; color?: string; isDefaultCalendar?: boolean }>;
    };
    return (j.value ?? []).map((c) => ({
      calendarId: c.id,
      name: c.name,
      color: c.color ?? null,
      isPrimary: Boolean(c.isDefaultCalendar),
    }));
  }
  const res = await fetchImpl(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const j = (await res.json().catch(() => ({}))) as {
    items?: Array<{ id: string; summary: string; backgroundColor?: string; primary?: boolean }>;
  };
  return (j.items ?? []).map((c) => ({
    calendarId: c.id,
    name: c.summary,
    color: c.backgroundColor ?? null,
    isPrimary: Boolean(c.primary),
  }));
}

/** Best-effort token revocation on disconnect. */
export async function revokeToken(
  provider: CalendarProvider,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  try {
    if (provider === 'google') {
      await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    }
    // Microsoft has no public per-token revoke endpoint; dropping the row +
    // letting the refresh token expire is the supported path.
  } catch {
    // best-effort
  }
}
