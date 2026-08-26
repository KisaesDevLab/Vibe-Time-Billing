// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Rendering helpers for the activity / audit / log surfaces. Those rows
// carry a uuid plus a name the API resolved for it; the name is what an
// operator reads, and the uuid is the fallback when the referenced row has
// been hard-deleted (or the kind has no name to look up).

/** "22a151d1…" — a uuid trimmed to something a person can eyeball. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/**
 * The name when the API resolved one, else the short-id stub. Never blank —
 * a log line with no actor at all is worse than one showing a stub.
 */
export function nameOrShortId(
  name: string | null | undefined,
  id: string | null | undefined,
): string {
  if (name) return name;
  if (id) return shortId(id);
  return '—';
}
