// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-1 — "Test Connection" for a firm's OAuth app registration. Validates
// the client id/secret WITHOUT a user present.
//
//  - Microsoft: a real client-credentials token grant against the tenant
//    token endpoint (Graph `.default` scope) — a 200 with an access_token
//    proves the app registration + secret are valid.
//  - Google: client-credentials isn't valid for Calendar, so we probe the
//    token endpoint with a deliberately-bad authorization_code. Google
//    answers `invalid_client` when the client id/secret are wrong and
//    `invalid_grant` (code bad) when they're right — so `invalid_grant`
//    means the credentials were accepted.

export interface ProviderTestResult {
  ok: boolean;
  detail: string;
}

type Fetch = typeof fetch;

export async function testMicrosoft(
  input: { clientId: string; clientSecret: string; tenantId: string },
  fetchImpl: Fetch = fetch,
): Promise<ProviderTestResult> {
  if (!input.tenantId) return { ok: false, detail: 'tenant_id_required' };
  const url = `https://login.microsoftonline.com/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (res.ok && json.access_token) return { ok: true, detail: 'Token acquired.' };
    return {
      ok: false,
      detail: json.error_description ?? json.error ?? `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'request_failed' };
  }
}

export async function testGoogle(
  input: { clientId: string; clientSecret: string },
  fetchImpl: Fetch = fetch,
): Promise<ProviderTestResult> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: 'authorization_code',
    code: 'invalid-probe-code',
    redirect_uri: 'https://localhost/probe',
  });
  try {
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    // invalid_client → bad id/secret. invalid_grant / invalid_request →
    // creds accepted, only the (bogus) code was rejected.
    if (json.error === 'invalid_client') {
      return { ok: false, detail: 'Invalid client ID or secret.' };
    }
    return { ok: true, detail: 'Credentials accepted by Google.' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'request_failed' };
  }
}

export async function testProvider(
  provider: 'microsoft' | 'google',
  input: { clientId: string; clientSecret: string; tenantId?: string | null },
  fetchImpl: Fetch = fetch,
): Promise<ProviderTestResult> {
  if (!input.clientId || !input.clientSecret) {
    return { ok: false, detail: 'client_id_and_secret_required' };
  }
  return provider === 'microsoft'
    ? testMicrosoft({ ...input, tenantId: input.tenantId ?? '' }, fetchImpl)
    : testGoogle(input, fetchImpl);
}
