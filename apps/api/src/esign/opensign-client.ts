// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Shared low-level OpenSign (Parse Server) client.
//
// This is the SINGLE place the Parse cloud-function plumbing lives —
// header/credential selection, the lazy operator-account session, and the
// raw file/contact/document primitives. Two consumers sit on top:
//   - the proposal e-sign provider (apps/api/src/esign/provider.ts), and
//   - the Signatures module's multi-signer + placeholder document creation
//     (apps/api/src/signatures/opensign-document.ts).
// Reuse-and-extend: there is no second OpenSign client.
//
// OpenSign self-host is a Parse Server. There is NO SaaS REST layer
// (`/api/v1.2/*`, `x-api-token`) — that only exists on OpenSign's hosted
// cloud. Server-to-server we use:
//   - master key (`X-Parse-Master-Key`) for READ paths that accept it:
//       getDocument, generatecertificate, getUserDetails, loginuser.
//   - a USER SESSION token (`X-Parse-Session-Token`) for the WRITE paths
//       that require `request.user`: savefile, savecontact,
//       createdocumentfromapp. The session is minted via the `loginuser`
//       cloud function using an operator-provisioned OpenSign API account.
//
// Cloud functions are invoked as:
//   POST {base}/functions/<fn>
//   headers: X-Parse-Application-Id, (X-Parse-Master-Key | X-Parse-Session-Token)
//   body:    JSON params
//   response: { "result": <value> }  (Parse convention; a function may
//             still embed a soft `{ error }` inside result)

export interface OpenSignClientOptions {
  // Parse API base, e.g. `https://opensign-caddy:4001/api/app` or
  // `http://opensign-server:8080/app`.
  baseUrl: string;
  appId: string;
  masterKey: string;
  // Public UI origin used to build signer URLs, e.g. https://localhost:4001.
  // Defaults to baseUrl with `/api/app` (or `/app`) stripped.
  publicUrl?: string;
  // Operator-provisioned OpenSign account used to mint a session token for
  // the write paths (savefile / savecontact / createdocumentfromapp).
  // Optional: when unset, the write paths throw a clear config error and
  // the read-only (master-key) paths still function.
  apiEmail?: string;
  apiPassword?: string;
  fetchImpl?: typeof fetch;
}

export interface OpenSignSession {
  sessionToken: string;
  // _User pointer id (CreatedBy).
  userId: string;
  // contracts_Users pointer id (ExtUserPtr).
  extUserId: string;
}

export interface ParseDoc {
  objectId?: string;
  IsCompleted?: boolean;
  IsDeclined?: boolean;
  IsSigned?: boolean;
  SignedUrl?: string;
  CertificateUrl?: string;
  updatedAt?: string;
  AuditTrail?: Array<{ Activity?: string; SignedOn?: string; UserPtr?: { Email?: string } }>;
  Signers?: Array<{ objectId?: string; Email?: string }>;
  Placeholders?: unknown[];
  [k: string]: unknown;
}

export interface ParsePointer {
  __type: 'Pointer';
  className: string;
  objectId: string;
}

export interface OpenSignPdfBytes {
  body: Buffer;
  contentType: string;
}

export interface OpenSignClient {
  readonly base: string;
  readonly appId: string;
  readonly publicUrl: string;
  /** Invoke a Parse cloud function with the chosen credential. */
  callFn(fn: string, params: Record<string, unknown>, auth: 'master' | 'session'): Promise<unknown>;
  /** Mint (or reuse) the operator-account session + resolve its pointers. */
  ensureSession(): Promise<OpenSignSession>;
  ptr(className: string, objectId: string): ParsePointer;
  /** Upload a base64 document → returns the OpenSign file URL. */
  saveFile(input: { base64: string; fileName: string }): Promise<{ url: string }>;
  /** Create / resolve a signer contact (contracts_Contactbook). */
  saveContact(input: {
    name: string;
    email: string;
    phone?: string;
  }): Promise<{ objectId: string }>;
  /** Resolve a document by id (master-key read). */
  getDocument(docId: string): Promise<ParseDoc>;
  /** Idempotently (re)generate the audit certificate (master-key). */
  generateCertificate(docId: string): Promise<{ CertificateUrl?: string }>;
  /** GET raw PDF bytes from an OpenSign file URL. */
  fetchPdfUrl(url: string): Promise<OpenSignPdfBytes>;
}

export function createOpenSignClient(opts: OpenSignClientOptions): OpenSignClient {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const base = opts.baseUrl.replace(/\/$/, '');
  const publicUrl = (
    opts.publicUrl ?? base.replace(/\/api\/app$/, '').replace(/\/app$/, '')
  ).replace(/\/$/, '');

  // Cached session context (lazily minted from the API account).
  let session: OpenSignSession | null = null;

  async function callFn(
    fn: string,
    params: Record<string, unknown>,
    auth: 'master' | 'session',
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'X-Parse-Application-Id': opts.appId,
      'Content-Type': 'application/json',
    };
    if (auth === 'master') {
      headers['X-Parse-Master-Key'] = opts.masterKey;
    } else {
      if (!session) throw new Error('opensign_session_unavailable');
      headers['X-Parse-Session-Token'] = session.sessionToken;
    }
    const res = await fetchImpl(`${base}/functions/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    const json = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok) {
      throw new Error(`opensign_${fn}_failed: ${json.error ?? res.status}`);
    }
    const result = json.result;
    if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
      throw new Error(
        `opensign_${fn}_failed: ${String((result as Record<string, unknown>)['error'])}`,
      );
    }
    return result;
  }

  async function ensureSession(): Promise<OpenSignSession> {
    if (session) return session;
    if (!opts.apiEmail || !opts.apiPassword) {
      throw new Error(
        'opensign_api_account_unconfigured — set OPENSIGN_API_EMAIL/OPENSIGN_API_PASSWORD',
      );
    }
    const login = (await callFn(
      'loginuser',
      { email: opts.apiEmail, password: opts.apiPassword },
      'master',
    )) as { sessionToken?: string; objectId?: string };
    if (!login?.sessionToken || !login?.objectId) {
      throw new Error('opensign_login_failed: no session token returned');
    }
    const ext = (await callFn('getUserDetails', { email: opts.apiEmail }, 'master')) as {
      objectId?: string;
    };
    if (!ext?.objectId) {
      throw new Error('opensign_extuser_not_found — API account has no contracts_Users row');
    }
    session = {
      sessionToken: login.sessionToken,
      userId: login.objectId,
      extUserId: ext.objectId,
    };
    return session;
  }

  function ptr(className: string, objectId: string): ParsePointer {
    return { __type: 'Pointer', className, objectId };
  }

  async function saveFile(input: { base64: string; fileName: string }): Promise<{ url: string }> {
    const upload = (await callFn(
      'savefile',
      { fileBase64: input.base64, fileName: input.fileName },
      'session',
    )) as { url?: string };
    if (!upload?.url) throw new Error('opensign_savefile_failed: no url');
    return { url: upload.url };
  }

  async function saveContact(input: {
    name: string;
    email: string;
    phone?: string;
  }): Promise<{ objectId: string }> {
    const params: Record<string, unknown> = { name: input.name, email: input.email };
    if (input.phone) params['phone'] = input.phone;
    const contact = (await callFn('savecontact', params, 'session')) as { objectId?: string };
    if (!contact?.objectId) throw new Error('opensign_savecontact_failed: no objectId');
    return { objectId: contact.objectId };
  }

  async function getDocument(docId: string): Promise<ParseDoc> {
    return (await callFn('getDocument', { docId }, 'master')) as ParseDoc;
  }

  async function generateCertificate(docId: string): Promise<{ CertificateUrl?: string }> {
    return (await callFn('generatecertificate', { docId }, 'master')) as {
      CertificateUrl?: string;
    };
  }

  async function fetchPdfUrl(url: string): Promise<OpenSignPdfBytes> {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-Parse-Application-Id': opts.appId },
    });
    if (!res.ok) {
      throw new Error(`opensign_certificate_fetch_failed: ${res.status}`);
    }
    const contentType = res.headers.get('content-type') ?? 'application/pdf';
    const body = Buffer.from(await res.arrayBuffer());
    return { body, contentType };
  }

  return {
    base,
    appId: opts.appId,
    publicUrl,
    callFn,
    ensureSession,
    ptr,
    saveFile,
    saveContact,
    getDocument,
    generateCertificate,
    fetchPdfUrl,
  };
}

/**
 * Build the shared client from the OPENSIGN_* env (same vars the proposal
 * provider + poll worker read). Returns null when OpenSign isn't wired
 * (OPENSIGN_URL unset) so callers can degrade cleanly.
 */
export function openSignClientFromEnv(env: NodeJS.ProcessEnv = process.env): OpenSignClient | null {
  const baseUrl = env['OPENSIGN_URL'];
  if (!baseUrl) return null;
  return createOpenSignClient({
    baseUrl,
    appId: env['OPENSIGN_APP_ID'] ?? 'opensign',
    masterKey: env['OPENSIGN_MASTER_KEY'] ?? '',
    publicUrl: env['OPENSIGN_PUBLIC_URL'],
    apiEmail: env['OPENSIGN_API_EMAIL'],
    apiPassword: env['OPENSIGN_API_PASSWORD'],
  });
}
