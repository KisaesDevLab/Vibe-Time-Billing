// SPDX-License-Identifier: Elastic-2.0
//
// Phase 3 item #8 — WebAuthn / passkey enrollment + assertion helpers.
//
// Optional second factor that replaces TOTP for staff who prefer
// passkeys / hardware keys. A successful assertion is treated as
// step-up equivalent to a fresh TOTP code by the staff routes.
//
// Storage shape (app_user_credential):
//   credentialId  — base64url string (the WebAuthnCredential.id)
//   publicKey     — base64url string of the COSE key bytes
//   signCount     — bigint counter (replay protection)
//   transports    — comma-joined string ("usb,internal,hybrid")
//
// We never log the publicKey or any client-data bytes. Challenges
// live in Redis under a per-user key with 5-minute TTL and are
// consumed exactly once (delete after verify).

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type WebAuthnCredential,
} from '@simplewebauthn/server';

const RP_NAME = 'Vibe Practice Management';

/** Relying Party domain. Required when WebAuthn endpoints are hit. */
export function rpId(): string {
  const v = process.env['WEBAUTHN_RP_ID'];
  if (!v) throw new Error('WEBAUTHN_RP_ID not configured');
  return v;
}

/** Full origin URL (with scheme). */
export function rpOrigin(): string {
  const v = process.env['WEBAUTHN_ORIGIN'];
  if (!v) throw new Error('WEBAUTHN_ORIGIN not configured');
  return v;
}

export interface StoredCredentialRow {
  id: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string;
}

function decodeBase64url(s: string): Uint8Array {
  // Node 18+ supports 'base64url' encoding natively on Buffer. Copy
  // into a fresh ArrayBuffer-backed Uint8Array so the type matches
  // simplewebauthn's `Uint8Array<ArrayBuffer>` expectation.
  const buf = Buffer.from(s, 'base64url');
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

function encodeBase64url(u: Uint8Array): string {
  return Buffer.from(u).toString('base64url');
}

function splitTransports(s: string): AuthenticatorTransportFuture[] {
  return s
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is AuthenticatorTransportFuture => t.length > 0);
}

export interface BuildRegistrationOptionsInput {
  appUserId: string;
  email: string;
  fullName: string;
  existing: StoredCredentialRow[];
}

export async function buildRegistrationOptions(
  input: BuildRegistrationOptionsInput,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId(),
    userName: input.email,
    userID: new TextEncoder().encode(input.appUserId),
    userDisplayName: input.fullName,
    attestationType: 'none',
    excludeCredentials: input.existing.map((c) => ({
      id: c.credentialId,
      transports: splitTransports(c.transports),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
}

export interface VerifyRegistrationInput {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}

export interface VerifiedRegistrationOutcome {
  ok: boolean;
  credential?: {
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string;
    aaguid: string | null;
    deviceType: string | null;
    backedUp: boolean;
  };
  error?: string;
}

export async function verifyRegistration(
  input: VerifyRegistrationInput,
): Promise<VerifiedRegistrationOutcome> {
  let result: VerifiedRegistrationResponse;
  try {
    result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: rpOrigin(),
      expectedRPID: rpId(),
      requireUserVerification: false, // 'preferred', not 'required'
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'verify_failed' };
  }
  if (!result.verified || !result.registrationInfo) {
    return { ok: false, error: 'not_verified' };
  }
  const ri = result.registrationInfo;
  const transports = input.response.response.transports
    ? input.response.response.transports.join(',')
    : '';
  return {
    ok: true,
    credential: {
      credentialId: ri.credential.id,
      publicKey: encodeBase64url(ri.credential.publicKey),
      signCount: ri.credential.counter,
      transports,
      aaguid: ri.aaguid && /^[0-9a-f-]{36}$/i.test(ri.aaguid) ? ri.aaguid : null,
      deviceType: ri.credentialDeviceType,
      backedUp: ri.credentialBackedUp,
    },
  };
}

export interface BuildAuthenticationOptionsInput {
  candidates: StoredCredentialRow[];
  // Passwordless primary sign-in passes 'required' — when the passkey is
  // the SOLE factor it must carry user verification (biometric/PIN) to be
  // genuine two-factor (possession + inherence). Step-up (password already
  // proven) keeps the default 'preferred'.
  userVerification?: 'preferred' | 'required';
}

export async function buildAuthenticationOptions(
  input: BuildAuthenticationOptionsInput,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rpId(),
    timeout: 60_000,
    userVerification: input.userVerification ?? 'preferred',
    allowCredentials: input.candidates.map((c) => ({
      id: c.credentialId,
      transports: splitTransports(c.transports),
    })),
  });
}

export interface VerifyAuthenticationInput {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credential: StoredCredentialRow;
  // Passwordless primary sign-in passes true so a sole-factor passkey
  // assertion is rejected unless the authenticator performed user
  // verification. Step-up leaves it false (password already supplied).
  requireUserVerification?: boolean;
}

export interface VerifiedAuthenticationOutcome {
  ok: boolean;
  newSignCount?: number;
  error?: string;
}

export async function verifyAuthentication(
  input: VerifyAuthenticationInput,
): Promise<VerifiedAuthenticationOutcome> {
  const credential: WebAuthnCredential = {
    id: input.credential.credentialId,
    // .slice() returns Uint8Array<ArrayBuffer>, matching simplewebauthn's
    // Uint8Array_ alias (= ReturnType<Uint8Array['slice']>).
    publicKey: decodeBase64url(input.credential.publicKey).slice(),
    counter: input.credential.signCount,
    transports: splitTransports(input.credential.transports),
  };
  let result: VerifiedAuthenticationResponse;
  try {
    result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: rpOrigin(),
      expectedRPID: rpId(),
      credential,
      requireUserVerification: input.requireUserVerification ?? false,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'verify_failed' };
  }
  if (!result.verified) return { ok: false, error: 'not_verified' };
  return { ok: true, newSignCount: result.authenticationInfo.newCounter };
}
