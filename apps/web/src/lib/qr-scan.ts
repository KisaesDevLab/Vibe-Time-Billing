// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// QR payload parsing for the client-QR feature. Route sheets encode the
// raw client UUID, but accept a UUID embedded anywhere in the payload
// (e.g. a /clients/<uuid> URL) so the printed format can evolve without
// breaking older scanners.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** First UUID found in a scanned payload (lowercased), or null. */
export function extractUuid(payload: string): string | null {
  const m = UUID_RE.exec(payload);
  return m ? m[0].toLowerCase() : null;
}
