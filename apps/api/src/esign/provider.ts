// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P15 — E-signature provider abstraction.
//
// Two implementations:
//   NativeProvider  — typed-name + drawn-SVG, sanitized server-side
//                     via CP8's sanitizeSignatureSvg. No third party.
//   OpenSignProvider — wraps the OpenSign sidecar's internal HTTP API.
//                      Sidecar lives in docker-compose; setup in P30.
//
// The provider interface is shape-stable so the P21 acceptance handler
// doesn't have to branch on which provider is wired. Firm-settings UI
// (deferred to P21 follow-up) picks the provider per firm.

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
  // OpenSign: signing happens in the sidecar's UI; sign() throws
  // because the staff side never calls it directly.
  sign(input: NativeSignInput): Promise<EsignEnvelope>;
  // Polling/refresh hook for OpenSign — returns current envelope
  // state. Native always returns the in-memory cached envelope.
  getStatus(envelopeId: string): Promise<EsignEnvelope>;
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
  };
}

// =====================================================================
// OpenSignProvider (sidecar HTTP shim)
// =====================================================================
//
// Wraps the OpenSign internal API. The sidecar runs on the same docker
// network; we authenticate with a shared secret (OPENSIGN_SHARED_SECRET
// env var). The sidecar exposes:
//   POST /api/envelopes        — create envelope (returns id + url)
//   GET  /api/envelopes/:id    — fetch status
//
// sign() is not used for OpenSign — clients sign through the sidecar's
// embedded UI, and a webhook from OpenSign updates the signatures row
// asynchronously. Calling sign() on this provider throws so we surface
// the wiring bug at the call site rather than silently misbehaving.

export interface OpenSignProviderOptions {
  baseUrl: string;
  sharedSecret: string;
  fetchImpl?: typeof fetch;
}

export function createOpenSignProvider(opts: OpenSignProviderOptions): EsignProvider {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);

  async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetchImpl(`${opts.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.sharedSecret}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `opensign_${path.slice(1).replace(/\//g, '_')}_failed: ${
          (json['error'] as string | undefined) ?? res.status
        }`,
      );
    }
    return json;
  }

  function deserialize(json: Record<string, unknown>): EsignEnvelope {
    return {
      providerId: 'opensign',
      envelopeId: String(json['id']),
      status:
        (String(json['status'] ?? 'PENDING').toUpperCase() as EsignEnvelopeStatus) ?? 'PENDING',
      signedAt: json['signedAt'] ? new Date(String(json['signedAt'])) : null,
      certificateObjectKey: (json['certificateObjectKey'] as string | null | undefined) ?? null,
    };
  }

  return {
    id: 'opensign',
    async createEnvelope(input) {
      const json = await call('/api/envelopes', {
        method: 'POST',
        body: JSON.stringify({
          title: input.documentTitle,
          html: input.documentHtml,
          signer: {
            name: input.signerName,
            email: input.signerEmail,
          },
          metadata: { proposalId: input.proposalId },
        }),
      });
      return deserialize(json);
    },
    async sign() {
      throw new Error(
        'opensign_sign_not_directly_invokable — clients sign through the sidecar UI; the webhook updates state',
      );
    },
    async getStatus(envelopeId) {
      const json = await call(`/api/envelopes/${envelopeId}`, { method: 'GET' });
      return deserialize(json);
    },
  };
}
