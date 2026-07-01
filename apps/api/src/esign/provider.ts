// SPDX-License-Identifier: Elastic-2.0
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

import { appendPdfPages } from '../lib/pdf-merge';
import { sanitizeSignatureSvg } from '../portal/signature-svg';
import { createOpenSignClient, type ParseDoc } from './opensign-client';

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

export function createOpenSignProvider(opts: OpenSignProviderOptions): EsignProvider {
  // The proposal provider and the Signatures module share ONE Parse client.
  const client = createOpenSignClient(opts);
  const publicUrl = client.publicUrl;

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

  return {
    id: 'opensign',
    async createEnvelope(input) {
      const ctx = await client.ensureSession();

      // 1. Upload the document PDF (base64) → returns a file URL.
      const upload = await client.saveFile({
        base64: toBase64(input.documentHtml),
        fileName: `${input.documentTitle.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'document'}.pdf`,
      });

      // 2. Create / resolve the signer contact (contracts_Contactbook).
      const contact = await client.saveContact({
        name: input.signerName,
        email: input.signerEmail,
      });

      // 3. Create the document and queue it for signature.
      const document = {
        Name: input.documentTitle,
        URL: upload.url,
        ExtUserPtr: client.ptr('contracts_Users', ctx.extUserId),
        CreatedBy: client.ptr('_User', ctx.userId),
        SendinOrder: false,
        SentToOthers: true,
        IsEnableOTP: false,
        Signers: [client.ptr('contracts_Contactbook', contact.objectId)],
        DocSentAt: { __type: 'Date', iso: new Date().toISOString() },
        // Pin OpenSign's expiry (default is ~15 days) so the signing page
        // doesn't show an earlier expiration than the rest of the app.
        TimeToCompleteDays: 30,
      };
      const created = (await client.callFn(
        'createdocumentfromapp',
        { document },
        'session',
      )) as ParseDoc;
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
      return deserialize(await client.getDocument(envelopeId));
    },
    async fetchCertificatePdf(envelopeId) {
      // Resolve the document, then fetch the PDF bytes. When BOTH the
      // signed document and the completion certificate exist, return ONE
      // PDF — signed pages with the certificate appended — so the stored
      // artifact carries the agreement and its audit trail together.
      // generatecertificate is idempotent + master-keyed.
      const doc = await client.getDocument(envelopeId);
      let certUrl = doc.CertificateUrl;
      if (!certUrl) {
        const gen = await client.generateCertificate(envelopeId);
        certUrl = gen?.CertificateUrl;
      }
      const signedUrl = doc.SignedUrl;
      if (!signedUrl && !certUrl) {
        throw new Error('opensign_certificate_unavailable: no signed/certificate url');
      }
      if (!signedUrl || !certUrl) {
        // Only one part exists — legacy single-file behavior.
        return client.fetchPdfUrl((certUrl ?? signedUrl)!);
      }
      const [signed, cert] = await Promise.all([
        client.fetchPdfUrl(signedUrl),
        client.fetchPdfUrl(certUrl),
      ]);
      const toBuf = (b: Buffer | string): Buffer => (Buffer.isBuffer(b) ? b : Buffer.from(b));
      try {
        const merged = await appendPdfPages(toBuf(signed.body), toBuf(cert.body));
        return { body: merged, contentType: 'application/pdf' };
      } catch {
        // Unmergeable bytes — keep the certificate (the audit evidence),
        // matching the pre-merge behavior.
        return { body: toBuf(cert.body), contentType: cert.contentType };
      }
    },
  };
}
