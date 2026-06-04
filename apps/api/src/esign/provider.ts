// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P15 / Q35 — E-signature provider abstraction.
//
// Two implementations:
//   NativeProvider  — typed-name + drawn-SVG, sanitized server-side
//                     via CP8's sanitizeSignatureSvg. No third party.
//   OpenSignProvider — talks to a REAL self-hosted OpenSign v2.x
//                      (OpenSignLabs/OpenSign) instance over its Parse
//                      Server cloud-function API. Deployed standalone via
//                      ops/docker/opensign/ and reached via OPENSIGN_URL.
//
// The provider interface is shape-stable so the P21 acceptance handler
// doesn't have to branch on which provider is wired. Firm-settings UI
// picks the provider per firm.

import { sanitizeSignatureSvg } from '../portal/signature-svg';

export type EsignEnvelopeStatus = 'PENDING' | 'SIGNED' | 'DECLINED' | 'CANCELLED';

export interface EsignEnvelope {
  providerId: 'native' | 'opensign';
  envelopeId: string;
  status: EsignEnvelopeStatus;
  signedAt: Date | null;
  // Signed PDF object key (for OpenSign — points at MinIO).
  // null for Native (no PDF generated; the signature event itself
  // is the proof).
  certificateObjectKey: string | null;
  // Q35 — OpenSign embedded signing URL. The portal redirects the
  // browser here for an OpenSign firm. Native returns null (it signs
  // inline in our portal).
  signingUrl: string | null;
}

// Q35 — the completion-cert PDF fetched from OpenSign. The API fetches
// it and writes it to OUR storage (OpenSign never receives our storage
// creds — see acceptance/completion flow).
export interface CertificatePdf {
  body: Buffer;
  contentType: string;
}

export interface CreateEnvelopeInput {
  proposalId: string;
  signerName: string;
  signerEmail: string;
  documentHtml: string;
  documentTitle: string;
}

export interface NativeSignInput {
  envelopeId: string;
  typedName: string;
  drawnSvg?: string | null;
  signerIp: string | null;
  signerUa: string | null;
  signedAt: Date;
}

export interface EsignProvider {
  id: 'native' | 'opensign';
  createEnvelope(input: CreateEnvelopeInput): Promise<EsignEnvelope>;
  // Native: pass typed name + optional drawn SVG, return signed
  // envelope inline (no third party round-trip).
  // OpenSign: signing happens in OpenSign's own UI; sign() throws
  // because the staff side never calls it directly.
  sign(input: NativeSignInput): Promise<EsignEnvelope>;
  // Polling/refresh hook for OpenSign — returns current envelope
  // state. Native always returns the in-memory cached envelope.
  getStatus(envelopeId: string): Promise<EsignEnvelope>;
  // Q35 — fetch the completion-certificate PDF for a signed envelope.
  // Native throws (no PDF generated; the signature event + HMAC is the
  // proof). OpenSign fetches the signed document (and/or the audit
  // certificate); the API then writes the bytes to OUR storage so
  // OpenSign never holds our creds.
  fetchCertificatePdf(envelopeId: string): Promise<CertificatePdf>;
}

// =====================================================================
// NativeProvider
// =====================================================================
//
// In-memory envelope store. Production wiring stores the envelope
// pointer alongside the signatures table row (the envelope id maps to
// a signatures.opensign_envelope_id-style column). For v1 the
// envelope is local-only and bound to a proposal acceptance request.

interface NativeStore {
  envelopes: Map<string, EsignEnvelope>;
}

export function createNativeProvider(store?: NativeStore): EsignProvider {
  const local: NativeStore = store ?? { envelopes: new Map() };
  return {
    id: 'native',
    async createEnvelope(input) {
      const id = `nat_${input.proposalId.replace(/-/g, '').slice(0, 12)}_${Date.now().toString(36)}`;
      const envelope: EsignEnvelope = {
        providerId: 'native',
        envelopeId: id,
        status: 'PENDING',
        signedAt: null,
        certificateObjectKey: null,
        // Native signs inline in our portal — no external signing URL.
        signingUrl: null,
      };
      local.envelopes.set(id, envelope);
      return envelope;
    },
    async sign(input) {
      const e = local.envelopes.get(input.envelopeId);
      if (!e) throw new Error('envelope_not_found');
      if (e.status !== 'PENDING') throw new Error(`envelope_not_signable:${e.status}`);
      if (!input.typedName || input.typedName.trim() === '') {
        throw new Error('typed_name_required');
      }
      if (input.drawnSvg) {
        const sanitized = sanitizeSignatureSvg(input.drawnSvg);
        if (!sanitized) throw new Error('invalid_signature_svg');
      }
      const next: EsignEnvelope = {
        ...e,
        status: 'SIGNED',
        signedAt: input.signedAt,
      };
      local.envelopes.set(input.envelopeId, next);
      return next;
    },
    async getStatus(envelopeId) {
      const e = local.envelopes.get(envelopeId);
      if (!e) throw new Error('envelope_not_found');
      return e;
    },
    async fetchCertificatePdf() {
      // Native produces no completion certificate — the signature row +
      // its HMAC is the proof of acceptance. The async completion flow
      // only calls this for OpenSign envelopes.
      throw new Error('native_certificate_not_supported');
    },
  };
}

// =====================================================================
// OpenSignProvider (real self-hosted Parse cloud-function client)
// =====================================================================
//
// OpenSign self-host is a Parse Server. There is NO SaaS REST layer
// (`/api/v1.2/*`, `x-api-token`) — that only exists on OpenSign's hosted
// cloud. Server-to-server we use:
//   - master key (`X-Parse-Master-Key`) for READ paths that accept it:
//       getDocument, generatecertificate, getUserDetails, loginuser.
//   - a USER SESSION token (`X-Parse-Session-Token`) for the WRITE paths
//       that require `request.user`: savefile, savecontact,
//       createdocumentfromapp. The session is minted via the `loginuser`
//       cloud function using an operator-provisioned OpenSign API
//       account (OPENSIGN_API_EMAIL / OPENSIGN_API_PASSWORD).
//
// Cloud functions are invoked as:
//   POST {base}/functions/<fn>
//   headers: X-Parse-Application-Id, (X-Parse-Master-Key | X-Parse-Session-Token)
//   body:    JSON params
//   response: { "result": <value> }  (Parse convention; a function may
//             still embed a soft `{ error }` inside result)
//
// The per-signer signing URL is the OpenSign UI route
// `${PUBLIC_URL}/load/recipientSignPdf/<docId>/<contactBookId>` (verified
// against apps/OpenSign/src/App.jsx). The browser is redirected there to
// sign; completion arrives via the OpenSign webhook (apps/api webhook).

export interface OpenSignProviderOptions {
  // Parse API base, e.g. `https://opensign-caddy:4001/api/app` or
  // `http://opensign-server:8080/app`.
  baseUrl: string;
  appId: string;
  masterKey: string;
  // Public UI origin used to build signer URLs, e.g. https://localhost:4001.
  // Defaults to baseUrl with `/api/app` (or `/app`) stripped.
  publicUrl?: string;
  // Operator-provisioned OpenSign account used to mint a session token
  // for the write paths (savefile / savecontact / createdocumentfromapp).
  // Optional: when unset, createEnvelope throws a clear config error and
  // the read-only (master-key) paths still function.
  apiEmail?: string;
  apiPassword?: string;
  fetchImpl?: typeof fetch;
}

interface ParseDoc {
  objectId?: string;
  IsCompleted?: boolean;
  IsDeclined?: boolean;
  IsSigned?: boolean;
  SignedUrl?: string;
  CertificateUrl?: string;
  updatedAt?: string;
  AuditTrail?: Array<{ Activity?: string; SignedOn?: string; UserPtr?: { Email?: string } }>;
  Signers?: Array<{ objectId?: string; Email?: string }>;
  [k: string]: unknown;
}

export function createOpenSignProvider(opts: OpenSignProviderOptions): EsignProvider {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const base = opts.baseUrl.replace(/\/$/, '');
  const publicUrl = (
    opts.publicUrl ?? base.replace(/\/api\/app$/, '').replace(/\/app$/, '')
  ).replace(/\/$/, '');

  // Cached session context (lazily minted from the API account).
  let session: {
    sessionToken: string;
    // _User pointer id (CreatedBy)
    userId: string;
    // contracts_Users pointer id (ExtUserPtr)
    extUserId: string;
  } | null = null;

  // Invoke a Parse cloud function. `auth` selects which credential to
  // present. Returns the unwrapped `result`. Throws on transport/Parse
  // errors AND on soft `{ error }` payloads embedded in the result.
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

  // Mint (or reuse) a user session token from the operator API account
  // and resolve the ExtUserPtr (contracts_Users) + CreatedBy (_User)
  // pointers the create flow requires.
  async function ensureSession(): Promise<NonNullable<typeof session>> {
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
    // Resolve the contracts_Users (ExtUserPtr) objectId for this account.
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

  function ptr(className: string, objectId: string) {
    return { __type: 'Pointer', className, objectId };
  }

  // Base64-encode the document for savefile (OpenSign flattens the PDF).
  function toBase64(s: string): string {
    return Buffer.from(s, 'utf8').toString('base64');
  }

  // Map an OpenSign document object to our EsignEnvelope.
  function deserialize(doc: ParseDoc): EsignEnvelope {
    let status: EsignEnvelopeStatus = 'PENDING';
    if (doc.IsDeclined) status = 'DECLINED';
    else if (doc.IsCompleted || doc.IsSigned) status = 'SIGNED';
    let signedAt: Date | null = null;
    if (status === 'SIGNED') {
      const signedActivity = doc.AuditTrail?.find(
        (a) => a.Activity === 'Signed' || a.Activity === 'signed',
      );
      const iso = signedActivity?.SignedOn ?? doc.updatedAt;
      signedAt = iso ? new Date(iso) : new Date();
    }
    return {
      providerId: 'opensign',
      envelopeId: String(doc.objectId ?? ''),
      status,
      signedAt,
      // We store the cert under OUR key after fetching the bytes; the raw
      // OpenSign cert URL isn't a stable object key, so leave null here.
      certificateObjectKey: null,
      signingUrl: null,
    };
  }

  // Fetch raw PDF bytes from an OpenSign file URL (presigned or local
  // JWT-token URL). For local storage the URL points at the OpenSign
  // server's /files/ endpoint; we GET it directly with the appId header.
  async function fetchPdfUrl(url: string): Promise<CertificatePdf> {
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
    id: 'opensign',
    async createEnvelope(input) {
      const ctx = await ensureSession();

      // 1. Upload the document PDF (base64) → returns a file URL.
      const upload = (await callFn(
        'savefile',
        {
          fileBase64: toBase64(input.documentHtml),
          fileName: `${input.documentTitle.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'document'}.pdf`,
        },
        'session',
      )) as { url?: string };
      if (!upload?.url) throw new Error('opensign_savefile_failed: no url');

      // 2. Create / resolve the signer contact (contracts_Contactbook).
      const contact = (await callFn(
        'savecontact',
        { name: input.signerName, email: input.signerEmail },
        'session',
      )) as { objectId?: string };
      if (!contact?.objectId) throw new Error('opensign_savecontact_failed: no objectId');

      // 3. Create the document and queue it for signature.
      const document = {
        Name: input.documentTitle,
        URL: upload.url,
        ExtUserPtr: ptr('contracts_Users', ctx.extUserId),
        CreatedBy: ptr('_User', ctx.userId),
        SendinOrder: false,
        SentToOthers: true,
        IsEnableOTP: false,
        Signers: [ptr('contracts_Contactbook', contact.objectId)],
        DocSentAt: { __type: 'Date', iso: new Date().toISOString() },
      };
      const created = (await callFn('createdocumentfromapp', { document }, 'session')) as ParseDoc;
      const envelopeId = String(created?.objectId ?? '');
      if (!envelopeId) throw new Error('opensign_createdocument_failed: no objectId');

      return {
        providerId: 'opensign',
        envelopeId,
        status: 'PENDING',
        signedAt: null,
        certificateObjectKey: null,
        // OpenSign UI signing route (verified in apps/OpenSign App.jsx).
        signingUrl: `${publicUrl}/load/recipientSignPdf/${envelopeId}/${contact.objectId}`,
      };
    },
    async sign() {
      throw new Error(
        'opensign_sign_not_directly_invokable — clients sign through the OpenSign UI; the webhook updates state',
      );
    },
    async getStatus(envelopeId) {
      const doc = (await callFn('getDocument', { docId: envelopeId }, 'master')) as ParseDoc;
      return deserialize(doc);
    },
    async fetchCertificatePdf(envelopeId) {
      // Resolve the document, then fetch the signed PDF bytes. Prefer the
      // completion certificate (audit trail); fall back to the signed
      // document URL. generatecertificate is idempotent + master-keyed.
      const doc = (await callFn('getDocument', { docId: envelopeId }, 'master')) as ParseDoc;
      let certUrl = doc.CertificateUrl;
      if (!certUrl) {
        const gen = (await callFn('generatecertificate', { docId: envelopeId }, 'master')) as {
          CertificateUrl?: string;
        };
        certUrl = gen?.CertificateUrl;
      }
      const target = certUrl ?? doc.SignedUrl;
      if (!target) throw new Error('opensign_certificate_unavailable: no signed/certificate url');
      return fetchPdfUrl(target);
    },
  };
}
