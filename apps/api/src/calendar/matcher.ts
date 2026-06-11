// SPDX-License-Identifier: Elastic-2.0
//
// CAL-4 — two-tier client matching (pure). Tier 1: exact attendee/organizer
// email → client contact. Tier 2: fuse.js fuzzy on a cleaned event subject
// vs client names. No confident match → unmatched. The LLM tier is a stub
// (llm-matcher.ts), gated behind FEATURE_LLM_CALENDAR_MATCH.

import Fuse from 'fuse.js';

export interface ClientForMatch {
  id: string;
  name: string;
  clientFacingName: string | null;
}

export interface ContactForMatch {
  clientId: string;
  email: string | null;
}

export interface EventForMatch {
  subject: string | null;
  organizerEmail: string | null;
  attendees: Array<{ email?: string | null }> | null;
}

export type MatchTier = 'exact_email' | 'fuzzy_name' | 'unmatched';

export interface MatchCandidate {
  clientId: string | null;
  score: number; // 0..1 (1 = exact)
  status: 'confirmed' | 'pending';
}

export interface MatchResult {
  tier: MatchTier;
  candidates: MatchCandidate[];
}

const PREFIX_RE = /^\s*(re|fwd|fw)\s*:\s*/i;
const MEETING_WORDS =
  /\b(call|meeting|appointment|appt|review|consult|consultation|sync|check[- ]?in|zoom|teams|webex|google\s*meet)\b/gi;
const DATE_TOKENS = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g;

/** Strip reply/forward prefixes, meeting-type words, and date tokens. */
export function cleanSubject(subject: string): string {
  let s = subject;
  for (let i = 0; i < 3; i++) {
    const m = PREFIX_RE.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  s = s
    .replace(MEETING_WORDS, ' ')
    .replace(DATE_TOKENS, ' ')
    .replace(/[-–—|@/]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function extractEmails(event: EventForMatch): string[] {
  const set = new Set<string>();
  if (event.organizerEmail) set.add(event.organizerEmail.toLowerCase());
  for (const a of event.attendees ?? []) {
    if (a.email) set.add(a.email.toLowerCase());
  }
  return [...set];
}

export function matchEvent(
  event: EventForMatch,
  clients: ClientForMatch[],
  contacts: ContactForMatch[],
): MatchResult {
  // Tier 1 — exact email.
  const emails = new Set(extractEmails(event));
  if (emails.size > 0) {
    const matchedClientIds = new Set<string>();
    for (const c of contacts) {
      if (c.email && emails.has(c.email.toLowerCase())) matchedClientIds.add(c.clientId);
    }
    if (matchedClientIds.size === 1) {
      return {
        tier: 'exact_email',
        candidates: [{ clientId: [...matchedClientIds][0]!, score: 1, status: 'confirmed' }],
      };
    }
    if (matchedClientIds.size > 1) {
      // Ambiguous — surface every candidate for human review.
      return {
        tier: 'exact_email',
        candidates: [...matchedClientIds].map((id) => ({
          clientId: id,
          score: 1,
          status: 'pending',
        })),
      };
    }
  }

  // Tier 2 — fuzzy name on the cleaned subject.
  const cleaned = event.subject ? cleanSubject(event.subject) : '';
  if (cleaned.length >= 2 && clients.length > 0) {
    const fuse = new Fuse(clients, {
      keys: ['name', 'clientFacingName'],
      threshold: 0.35,
      includeScore: true,
      ignoreLocation: true,
    });
    const results = fuse.search(cleaned);
    const top = results[0];
    // fuse score is inverted (0 = perfect); accept when 1 - score >= 0.65.
    if (top && typeof top.score === 'number' && 1 - top.score >= 0.65) {
      return {
        tier: 'fuzzy_name',
        candidates: [{ clientId: top.item.id, score: 1 - top.score, status: 'pending' }],
      };
    }
  }

  return { tier: 'unmatched', candidates: [{ clientId: null, score: 0, status: 'pending' }] };
}
